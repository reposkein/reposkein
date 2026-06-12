//! reposkein-core: deterministic repository indexing primitives.

pub mod classify;
pub mod extractor;
pub mod hash;
pub mod id;
pub mod jsonl;
pub mod merge;
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

/// Builds the structural graph for `root`. Deterministic given (tree, repo).
/// `repo` is the repo_id; `repo_name` labels the Repository node.
pub fn index_tree(
    root: &Path,
    repo: &str,
    repo_name: &str,
    extractors: &[&dyn Extractor],
) -> Result<Graph> {
    let entries = walk::walk(root)?;

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
                let mut out = ext_impl.extract(&ctx);
                nodes.append(&mut out.nodes);
                edges.append(&mut out.edges);
                all_imports.append(&mut out.imports);
                all_calls.append(&mut out.calls);
            }
        }
    }

    let mut resolved = resolve::resolve(&nodes, &all_imports, &all_calls, repo);
    edges.append(&mut resolved);

    Ok(Graph { nodes, edges })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

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
}
