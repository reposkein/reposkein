//! reposkein-core: deterministic repository indexing primitives.

pub mod cache;
pub mod classify;
pub mod extractor;
pub mod hash;
pub mod id;
pub mod jsonl;
pub mod merge;
pub mod meta;
pub mod model;
pub mod resolve;
pub mod walk;

use anyhow::Result;
use extractor::{Extractor, FileContext};
use model::{Edge, Node};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

/// Returns the repo-relative parent directory path for a forward-slash path.
/// Top-level entries have parent ".".
fn parent_of(rel_path: &str) -> String {
    match rel_path.rfind('/') {
        Some(idx) => rel_path[..idx].to_string(),
        None => ".".to_string(),
    }
}

fn extension_of(rel_path: &str) -> String {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    match name.rfind('.') {
        Some(idx) if idx > 0 => name[idx + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn basename_of(rel_path: &str) -> String {
    rel_path.rsplit('/').next().unwrap_or(rel_path).to_string()
}

/// Options for `index_tree_with`.
#[derive(Clone, Copy, Default)]
pub struct IndexOptions<'a> {
    pub federation: bool,
    /// Optional per-file extraction cache (skips re-parsing unchanged files).
    pub cache: Option<&'a dyn cache::ExtractCache>,
}

/// Information about a federated child repository detected during indexing.
#[derive(Debug, Clone, PartialEq)]
pub struct ChildRepoInfo {
    pub rel_path: String,
    pub repo_id: String,
    pub name: String,
}

/// Output of `index_tree_with`.
#[derive(Debug, Clone)]
pub struct IndexOutput {
    pub graph: Graph,
    pub children: Vec<ChildRepoInfo>,
    pub warnings: Vec<String>,
}

/// Builds the structural graph for `root`. Deterministic given (tree, repo).
/// `repo` is the repo_id; `repo_name` labels the Repository node.
/// Thin wrapper around `index_tree_with` with federation disabled.
pub fn index_tree(
    root: &Path,
    repo: &str,
    repo_name: &str,
    extractors: &[&dyn Extractor],
) -> Result<Graph> {
    Ok(index_tree_with(root, repo, repo_name, extractors, IndexOptions::default())?.graph)
}

/// Federation-aware indexing. When `opts.federation` is true, nested-repo
/// boundaries are detected, pruned from the walk, and emitted as proxy
/// `Repository` nodes + `FEDERATES_TO` edges in the root's graph.
pub fn index_tree_with(
    root: &Path,
    repo: &str,
    repo_name: &str,
    extractors: &[&dyn Extractor],
    opts: IndexOptions<'_>,
) -> Result<IndexOutput> {
    let walk_out = walk::walk_federated(root, opts.federation)?;
    let entries = walk_out.entries;

    let mut nodes: Vec<Node> = Vec::new();
    let mut edges: Vec<Edge> = Vec::new();
    let mut all_imports: Vec<extractor::RawImport> = Vec::new();
    let mut all_calls: Vec<extractor::RawCall> = Vec::new();

    // Repository node (root_path is "." by convention).
    nodes.push(
        Node::new(id::repo_id(repo, "."), "Repository")
            .set("name", json!(repo_name))
            .set("root_path", json!("."))
            .set("is_nested", json!(false)),
    );

    // Always-present root directory node.
    let mut dir_paths: BTreeSet<String> = BTreeSet::new();
    dir_paths.insert(".".to_string());

    // First pass: collect all directory paths.
    for e in &entries {
        if e.is_dir {
            dir_paths.insert(e.rel_path.clone());
        }
    }
    for d in &dir_paths {
        let name = if d == "." {
            ".".to_string()
        } else {
            basename_of(d)
        };
        nodes.push(
            Node::new(id::dir_id(repo, d), "Directory")
                .set("path", json!(d))
                .set("name", json!(name)),
        );
    }

    // Second pass: file nodes + CONTAINS edges for every entry.
    for e in &entries {
        let parent = parent_of(&e.rel_path);
        let parent_node = id::dir_id(repo, &parent);

        if e.is_dir {
            edges.push(Edge::new(
                parent_node,
                "CONTAINS",
                id::dir_id(repo, &e.rel_path),
            ));
        } else {
            let ext = extension_of(&e.rel_path);
            let bytes = std::fs::read(&e.abs_path)?;
            let content_hash = hash::content_hash(&bytes);
            let language = classify::language_for(&ext);
            let role = classify::role_for(&e.rel_path, &ext);

            let file_id = id::file_id(repo, &e.rel_path);

            let mut file = Node::new(file_id.clone(), "File")
                .set("path", json!(e.rel_path))
                .set("name", json!(basename_of(&e.rel_path)))
                .set("language", json!(language))
                .set("role", json!(role))
                .set("content_hash", json!(content_hash));
            if !ext.is_empty() {
                file = file.set("extension", Value::String(ext));
            }
            nodes.push(file);

            edges.push(Edge::new(parent_node, "CONTAINS", file_id.clone()));

            if let Some(ext_impl) = extractors.iter().find(|x| x.language() == language) {
                let ctx = FileContext {
                    repo,
                    rel_path: &e.rel_path,
                    file_id: &file_id,
                    source: &bytes,
                };
                let mut extracted = match opts.cache {
                    Some(c) => match c.get(repo, &e.rel_path, &content_hash) {
                        Some(hit) => hit,
                        None => {
                            let fresh = ext_impl.extract(&ctx);
                            c.put(repo, &e.rel_path, &content_hash, &fresh);
                            fresh
                        }
                    },
                    None => ext_impl.extract(&ctx),
                };
                nodes.append(&mut extracted.nodes);
                edges.append(&mut extracted.edges);
                all_imports.append(&mut extracted.imports);
                all_calls.append(&mut extracted.calls);
            }
        }
    }

    let mut resolved = resolve::resolve(&nodes, &all_imports, &all_calls, repo);
    edges.append(&mut resolved);

    // --- Federation records for ReposkeinChild boundaries ---
    let mut children: Vec<ChildRepoInfo> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for b in &walk_out.boundaries {
        match b.kind {
            walk::BoundaryKind::ReposkeinChild => {
                let meta_path = b.abs_path.join(".reposkein").join("meta.json");
                let child_repo_id = std::fs::read_to_string(&meta_path)
                    .ok()
                    .and_then(|t| meta::repo_id_from_meta(&t));
                match child_repo_id {
                    Some(cid) => {
                        let name = basename_of(&b.rel_path);
                        let proxy_id = id::repo_id(repo, &b.rel_path);
                        nodes.push(
                            Node::new(proxy_id.clone(), "Repository")
                                .set("name", json!(name))
                                .set("root_path", json!(b.rel_path))
                                .set("is_nested", json!(true))
                                .set("federated_repo_id", json!(cid.clone())),
                        );
                        edges.push(Edge::new(
                            id::repo_id(repo, "."),
                            "FEDERATES_TO",
                            proxy_id,
                        ));
                        children.push(ChildRepoInfo {
                            rel_path: b.rel_path.clone(),
                            repo_id: cid,
                            name,
                        });
                    }
                    None => warnings.push(format!(
                        "nested RepoSkein dir at '{}' has unreadable meta.json; not federated",
                        b.rel_path
                    )),
                }
            }
            walk::BoundaryKind::GitOnly => warnings.push(format!(
                "nested git repo without RepoSkein index at '{}'; run `reposkein-indexer index` inside it to federate",
                b.rel_path
            )),
        }
    }
    children.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let edges = drop_dangling_edges(&nodes, edges);

    Ok(IndexOutput {
        graph: Graph { nodes, edges },
        children,
        warnings,
    })
}

/// Removes edges whose endpoints are not present in the node set. Dangling
/// cross-file structural edges (e.g. INHERITS to a base defined in another
/// file) carry no information and would be silently dropped by the DB import,
/// breaking the byte-identical load->export round-trip (PRD §6.2.7).
fn drop_dangling_edges(nodes: &[Node], edges: Vec<Edge>) -> Vec<Edge> {
    let ids: std::collections::HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    edges
        .into_iter()
        .filter(|e| ids.contains(e.from.as_str()) && ids.contains(e.to.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn federated_index_emits_proxy_and_federates_to() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("top.py"), b"x = 1\n").unwrap();
        fs::create_dir_all(root.join("vendor/childA/.reposkein")).unwrap();
        fs::write(
            root.join("vendor/childA/.reposkein/meta.json"),
            b"{\"repo_id\":\"childa\"}",
        )
        .unwrap();
        fs::write(root.join("vendor/childA/inner.py"), b"y = 2\n").unwrap();

        let out = index_tree_with(
            root,
            "rootid",
            "root",
            &[],
            IndexOptions { federation: true, cache: None },
        )
        .unwrap();

        // Proxy Repository node owned by the root, pointing at the child.
        let proxy = out
            .graph
            .nodes
            .iter()
            .find(|n| n.id == "rs1:rootid:repo:vendor/childA")
            .expect("proxy node");
        assert_eq!(proxy.labels, ["Repository"]);
        assert_eq!(proxy.props["federated_repo_id"], json!("childa"));
        assert_eq!(proxy.props["is_nested"], json!(true));
        assert_eq!(proxy.props["root_path"], json!("vendor/childA"));
        // FEDERATES_TO root -> proxy.
        assert!(out.graph.edges.iter().any(|e| e.from == "rs1:rootid:repo:."
            && e.typ == "FEDERATES_TO"
            && e.to == "rs1:rootid:repo:vendor/childA"));
        // Child source NOT indexed under the root.
        assert!(!out.graph.nodes.iter().any(|n| n.id.contains("inner.py")));
        // The boundary dir still has a Directory node.
        assert!(out
            .graph
            .nodes
            .iter()
            .any(|n| n.id == "rs1:rootid:dir:vendor/childA"));
        // children reported.
        assert_eq!(out.children.len(), 1);
        assert_eq!(out.children[0].repo_id, "childa");
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.py"), b"print(1)\n").unwrap();
        fs::write(root.join("README.md"), b"# hi\n").unwrap();
        dir
    }

    #[test]
    fn builds_repo_dir_file_nodes_and_contains_edges() {
        let dir = fixture();
        let g = index_tree(dir.path(), "r", "demo", &[]).unwrap();

        let ids: Vec<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"rs1:r:repo:."));
        assert!(ids.contains(&"rs1:r:dir:."));
        assert!(ids.contains(&"rs1:r:dir:src"));
        assert!(ids.contains(&"rs1:r:file:src/a.py"));
        assert!(ids.contains(&"rs1:r:file:README.md"));

        // src dir is contained by root; a.py is contained by src.
        let has = |from: &str, to: &str| {
            g.edges
                .iter()
                .any(|e| e.from == from && e.typ == "CONTAINS" && e.to == to)
        };
        assert!(has("rs1:r:dir:.", "rs1:r:dir:src"));
        assert!(has("rs1:r:dir:src", "rs1:r:file:src/a.py"));
        assert!(has("rs1:r:dir:.", "rs1:r:file:README.md"));
    }

    #[test]
    fn determinism_two_runs_byte_identical() {
        let dir = fixture();
        let g1 = index_tree(dir.path(), "r", "demo", &[]).unwrap();
        let g2 = index_tree(dir.path(), "r", "demo", &[]).unwrap();
        assert_eq!(
            jsonl::nodes_to_jsonl(&g1.nodes),
            jsonl::nodes_to_jsonl(&g2.nodes)
        );
        assert_eq!(
            jsonl::edges_to_jsonl(&g1.edges),
            jsonl::edges_to_jsonl(&g2.edges)
        );
    }

    #[test]
    fn drop_dangling_edges_removes_unmatched_endpoints() {
        let nodes = vec![Node::new("a", "File"), Node::new("b", "Function")];
        let edges = vec![
            Edge::new("a", "DEFINES", "b"),      // both exist — kept
            Edge::new("a", "INHERITS", "ghost"), // dangling to — dropped
            Edge::new("ghost", "CALLS", "b"),    // dangling from — dropped
        ];
        let out = drop_dangling_edges(&nodes, edges);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].typ, "DEFINES");
    }
}
