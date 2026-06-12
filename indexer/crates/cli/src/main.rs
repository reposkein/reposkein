//! reposkein-indexer CLI. M0: the `index` subcommand walks a repository and
//! writes canonical `.reposkein/nodes.jsonl` + `.reposkein/edges.jsonl`.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use reposkein_core::{index_tree_with, jsonl};
use reposkein_lang_python::PythonExtractor;
use reposkein_lang_rust::RustExtractor;
use reposkein_lang_ts::{JavaScriptExtractor, TypeScriptExtractor};
use std::path::{Path, PathBuf};
use std::process::Command;

const PRE_COMMIT: &str = r#"#!/bin/sh
# RepoSkein: keep .reposkein JSONL in sync with the working tree on commit.
BIN="${REPOSKEIN_INDEXER_BIN:-reposkein-indexer}"
if ! command -v "$BIN" >/dev/null 2>&1 && [ ! -x "$BIN" ]; then
  echo "reposkein: indexer not found; skipping graph export (commit continues)" >&2
  exit 0
fi
"$BIN" index . >/dev/null 2>&1 || { echo "reposkein: index failed; skipping export" >&2; exit 0; }
git add .reposkein/nodes.jsonl .reposkein/edges.jsonl >/dev/null 2>&1 || true
exit 0
"#;

const POST_MERGE: &str = r#"#!/bin/sh
# RepoSkein: import the merged graph into the local database (async, best-effort).
BIN="${REPOSKEIN_INDEXER_BIN:-reposkein-indexer}"
if ! command -v "$BIN" >/dev/null 2>&1 && [ ! -x "$BIN" ]; then
  echo "reposkein: indexer not found; skipping graph import" >&2
  exit 0
fi
( "$BIN" load . >/dev/null 2>&1 || echo "reposkein: graph import skipped (database unavailable)" >&2 ) &
exit 0
"#;

#[derive(Parser)]
#[command(
    name = "reposkein-indexer",
    version,
    about = "RepoSkein native indexer"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Index a repository tree into canonical JSONL under .reposkein/.
    Index {
        /// Repository root to index (defaults to current directory).
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Override the computed repo_id (use for reproducible output).
        #[arg(long)]
        repo_id: Option<String>,
        /// Repository display name (defaults to the root directory name).
        #[arg(long)]
        name: Option<String>,
        /// Disable nested-repo federation (index child repos' sources under this repo).
        #[arg(long)]
        no_federation: bool,
    },
    /// Load committed .reposkein JSONL into Neo4j (reconstruct the DB).
    Load {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        repo_id: Option<String>,
        /// Skip federation: load only this repo's JSONL (no child repos).
        #[arg(long)]
        no_federation: bool,
    },
    /// Export the repo's graph from Neo4j to .reposkein JSONL.
    Export {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        repo_id: Option<String>,
        #[arg(long)]
        full: bool,
    },
    /// Check Neo4j connectivity and version.
    Doctor,
    /// Delete all graph data for a repo_id (or a whole federation) from Neo4j.
    Purge {
        /// Delete only this repo_id's nodes.
        #[arg(long)]
        repo: Option<String>,
        /// Delete all repos in the federation rooted at `path`.
        #[arg(long)]
        federation: bool,
        /// Repository root (used with --federation to locate JSONL).
        #[arg(default_value = ".")]
        path: PathBuf,
    },
    /// Install git hooks, .gitattributes merge lines, and the JSONL merge driver.
    Init {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Install git hooks + merge driver (currently the only init action).
        #[arg(long)]
        hooks: bool,
    },
    /// Git merge driver for canonical JSONL: <base> <ours> <theirs>; result
    /// is written back to the <ours> path.
    MergeJsonl {
        #[arg(long, value_parser = ["nodes", "edges"])]
        kind: Option<String>,
        base: PathBuf,
        ours: PathBuf,
        theirs: PathBuf,
    },
}

/// Best-effort: pulls the repo's nodes (with summaries) from Neo4j so the
/// agent's MCP-written summaries can be grafted into committed JSONL. Returns
/// None if no DB is configured/reachable — the caller then keeps JSONL grafts
/// only (graceful degradation, never blocks a commit).
fn db_summary_nodes(repo: &str) -> Option<Vec<reposkein_core::model::Node>> {
    if std::env::var("NEO4J_PASSWORD").is_err() {
        return None; // no DB configured → skip (fast path)
    }
    let store = reposkein_neo4j_io::Neo4jStore::from_env().ok()?;
    match store.export_graph(repo) {
        Ok(graph) => Some(graph.nodes),
        Err(_) => None,
    }
}

fn run_git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Canonicalizes a git remote URL to `host/org/repo` so all schemes
/// (https, scp-style git@, ssh://) produce the same repo_id.
pub(crate) fn normalize_remote(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    if let Some(i) = s.find("://") {
        s = s[i + 3..].to_string(); // drop scheme://
    }
    if let Some(i) = s.find('@') {
        s = s[i + 1..].to_string(); // drop user@
    }
    if let Some(stripped) = s.strip_suffix(".git") {
        s = stripped.to_string();
    }
    // scp form host:org/repo → host/org/repo (first ':' becomes '/')
    if let Some(i) = s.find(':') {
        s.replace_range(i..i + 1, "/");
    }
    s
}

/// repo_id resolution order: explicit flag → committed meta.json → computed.
fn resolve_repo_id(path: &Path, flag: Option<String>) -> String {
    if let Some(id) = flag {
        return id;
    }
    let meta = path.join(".reposkein").join("meta.json");
    if let Ok(text) = std::fs::read_to_string(&meta) {
        if let Some(id) = reposkein_core::meta::repo_id_from_meta(&text) {
            return id;
        }
    }
    compute_repo_id(path)
}

const DEFAULT_CONFIG_TOML: &str = r#"# RepoSkein configuration (committed; no secrets).
schema_version = 1

[languages]
enabled = ["python", "typescript", "rust"]

[neo4j]
uri = "neo4j://localhost:7687"
# credentials come from env (NEO4J_USER / NEO4J_PASSWORD), never committed
"#;

/// Writes meta.json, .reposkein/.gitignore, default config.toml (if absent),
/// and the git-ignored local/ dir.
fn write_reposkein_layout(out_dir: &Path, repo_id: &str) -> Result<()> {
    std::fs::write(
        out_dir.join("meta.json"),
        reposkein_core::meta::meta_json(repo_id),
    )?;
    std::fs::write(out_dir.join(".gitignore"), "local/\n")?;
    std::fs::create_dir_all(out_dir.join("local"))?;
    let cfg = out_dir.join("config.toml");
    if !cfg.exists() {
        std::fs::write(cfg, DEFAULT_CONFIG_TOML)?;
    }
    Ok(())
}

/// repo_id = BLAKE3(first_commit_hash + "\n" + normalized_origin_url), 12 hex chars.
/// Falls back to a hash of the absolute root path when git is unavailable.
fn compute_repo_id(root: &Path) -> String {
    let first = run_git(root, &["rev-list", "--max-parents=0", "HEAD"])
        .unwrap_or_default()
        .lines()
        .next() // first root commit only (multi-root repos)
        .unwrap_or_default()
        .to_string();
    let remote = run_git(root, &["remote", "get-url", "origin"])
        .map(|u| normalize_remote(&u))
        .unwrap_or_default();
    let basis = if first.is_empty() && remote.is_empty() {
        root.canonicalize()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| root.to_string_lossy().to_string())
    } else {
        format!("{first}\n{remote}")
    };
    blake3::hash(basis.as_bytes()).to_hex().to_string()[..12].to_string()
}

/// Loads a repo's JSONL into the DB (purge-then-import), then recurses into its
/// federated children (proxy Repository nodes carrying `federated_repo_id` +
/// `root_path`). JSONL-driven so it reconstructs purely from committed files.
/// Returns (repos_loaded, nodes_loaded, edges_loaded).
fn load_federation(
    store: &reposkein_neo4j_io::Neo4jStore,
    path: &Path,
    repo_id: &str,
    seen: &mut std::collections::BTreeSet<String>,
    skipped: &mut Vec<String>,
) -> Result<(u64, u64, u64)> {
    if !seen.insert(repo_id.to_string()) {
        return Ok((0, 0, 0)); // already loaded (cycle/diamond guard)
    }
    let dir = path.join(".reposkein");
    let (nodes_txt, edges_txt) = match (
        std::fs::read_to_string(dir.join("nodes.jsonl")),
        std::fs::read_to_string(dir.join("edges.jsonl")),
    ) {
        (Ok(n), Ok(e)) => (n, e),
        _ => {
            skipped.push(path.display().to_string());
            return Ok((0, 0, 0));
        }
    };
    let nodes = reposkein_core::jsonl::read_nodes(&nodes_txt)?;
    let edges = reposkein_core::jsonl::read_edges(&edges_txt)?;
    store.purge(repo_id)?;
    store.import_graph(
        repo_id,
        &reposkein_core::Graph {
            nodes: nodes.clone(),
            edges: edges.clone(),
        },
    )?;
    let mut repos = 1u64;
    let mut n = nodes.len() as u64;
    let mut e = edges.len() as u64;
    for node in &nodes {
        if node.labels == ["Repository"] {
            if let (Some(fed), Some(rp)) = (
                node.props.get("federated_repo_id").and_then(|v| v.as_str()),
                node.props.get("root_path").and_then(|v| v.as_str()),
            ) {
                let (cr, cn, ce) =
                    load_federation(store, &path.join(rp), fed, seen, skipped)?;
                repos += cr;
                n += cn;
                e += ce;
            }
        }
    }
    Ok((repos, n, e))
}

/// Collects a federation's repo_ids from committed JSONL (no DB), starting at
/// `repo_id`/`path` and following proxy `federated_repo_id`/`root_path`.
fn federation_repo_ids(
    path: &Path,
    repo_id: &str,
    seen: &mut std::collections::BTreeSet<String>,
) {
    if !seen.insert(repo_id.to_string()) {
        return;
    }
    let nodes_path = path.join(".reposkein").join("nodes.jsonl");
    let Ok(txt) = std::fs::read_to_string(&nodes_path) else {
        return;
    };
    let Ok(nodes) = reposkein_core::jsonl::read_nodes(&txt) else {
        return;
    };
    for node in &nodes {
        if node.labels == ["Repository"] {
            if let (Some(fed), Some(rp)) = (
                node.props.get("federated_repo_id").and_then(|v| v.as_str()),
                node.props.get("root_path").and_then(|v| v.as_str()),
            ) {
                federation_repo_ids(&path.join(rp), fed, seen);
            }
        }
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Index {
            path,
            repo_id,
            name,
            no_federation,
        } => {
            let repo = resolve_repo_id(&path, repo_id);
            let repo_name = name.unwrap_or_else(|| {
                path.canonicalize()
                    .ok()
                    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                    .unwrap_or_else(|| "repo".to_string())
            });

            let python = PythonExtractor;
            let typescript = TypeScriptExtractor;
            let javascript = JavaScriptExtractor;
            let rust = RustExtractor;
            let extractors: &[&dyn reposkein_core::extractor::Extractor] =
                &[&python, &typescript, &javascript, &rust];
            let opts = reposkein_core::IndexOptions {
                federation: !no_federation,
            };
            let out = index_tree_with(&path, &repo, &repo_name, extractors, opts)
                .context("failed to index repository tree")?;

            // Collision guard: a child repo_id must not equal the root's or a sibling's.
            let mut seen = std::collections::BTreeSet::new();
            for c in &out.children {
                if c.repo_id == repo {
                    anyhow::bail!(
                        "federation: child '{}' has the same repo_id as the root ({}); re-index it after deleting its .reposkein/meta.json",
                        c.rel_path,
                        repo
                    );
                }
                if !seen.insert(c.repo_id.clone()) {
                    anyhow::bail!(
                        "federation: duplicate child repo_id '{}' (e.g. a copied repo dir); re-index the duplicate to mint a fresh id",
                        c.repo_id
                    );
                }
            }
            for w in &out.warnings {
                eprintln!("reposkein: {w}");
            }
            let graph = out.graph;

            let out_dir = path.join(".reposkein");
            std::fs::create_dir_all(&out_dir).context("failed to create .reposkein/")?;
            let nodes_path = out_dir.join("nodes.jsonl");
            // 1) Preserve summaries already committed in JSONL (hash-validated).
            let mut nodes = if nodes_path.exists() {
                let prev =
                    std::fs::read_to_string(&nodes_path).context("read existing nodes.jsonl")?;
                let existing = reposkein_core::jsonl::read_nodes(&prev)?;
                reposkein_core::merge::graft_summaries(&graph.nodes, &existing)
            } else {
                graph.nodes.clone()
            };
            // 2) Overlay the live DB's summaries (the agent's latest, hash-valid)
            //    so MCP-written summaries reach committed JSONL (PRD §9 Phase 3).
            if let Some(db_nodes) = db_summary_nodes(&repo) {
                nodes = reposkein_core::merge::graft_summaries(&nodes, &db_nodes);
            }
            std::fs::write(&nodes_path, jsonl::nodes_to_jsonl(&nodes))
                .context("failed to write nodes.jsonl")?;
            std::fs::write(
                out_dir.join("edges.jsonl"),
                jsonl::edges_to_jsonl(&graph.edges),
            )
            .context("failed to write edges.jsonl")?;

            write_reposkein_layout(&out_dir, &repo).context("failed to write .reposkein layout")?;

            println!(
                "indexed repo_id={repo} name={repo_name}: {} nodes, {} edges, {} federated children",
                graph.nodes.len(),
                graph.edges.len(),
                out.children.len()
            );
            Ok(())
        }
        Commands::Load {
            path,
            repo_id,
            no_federation,
        } => {
            let repo = resolve_repo_id(&path, repo_id);
            let store = reposkein_neo4j_io::Neo4jStore::from_env()?;
            if no_federation {
                let dir = path.join(".reposkein");
                let nodes = reposkein_core::jsonl::read_nodes(
                    &std::fs::read_to_string(dir.join("nodes.jsonl"))
                        .context("read nodes.jsonl")?,
                )?;
                let edges = reposkein_core::jsonl::read_edges(
                    &std::fs::read_to_string(dir.join("edges.jsonl"))
                        .context("read edges.jsonl")?,
                )?;
                store.purge(&repo)?;
                store.import_graph(&repo, &reposkein_core::Graph { nodes, edges })?;
                println!("loaded repo_id={repo} (no federation)");
            } else {
                let mut seen = std::collections::BTreeSet::new();
                let mut skipped = Vec::new();
                let (repos, n, e) =
                    load_federation(&store, &path, &repo, &mut seen, &mut skipped)?;
                let stitches = store.stitch_federation()?;
                for s in &skipped {
                    eprintln!("reposkein: skipped (no .reposkein JSONL): {s}");
                }
                println!(
                    "loaded {repos} repo(s): {n} nodes, {e} edges; {stitches} federation stitch(es)"
                );
            }
            Ok(())
        }
        Commands::Export {
            path,
            repo_id,
            full: _,
        } => {
            let repo = resolve_repo_id(&path, repo_id);
            let store = reposkein_neo4j_io::Neo4jStore::from_env()?;
            let graph = store.export_graph(&repo)?;
            let dir = path.join(".reposkein");
            std::fs::create_dir_all(&dir)?;
            std::fs::write(
                dir.join("nodes.jsonl"),
                reposkein_core::jsonl::nodes_to_jsonl(&graph.nodes),
            )?;
            std::fs::write(
                dir.join("edges.jsonl"),
                reposkein_core::jsonl::edges_to_jsonl(&graph.edges),
            )?;
            println!(
                "exported repo_id={repo}: {} nodes, {} edges",
                graph.nodes.len(),
                graph.edges.len()
            );
            Ok(())
        }
        Commands::Doctor => {
            let store = reposkein_neo4j_io::Neo4jStore::from_env()?;
            let r = store.doctor()?;
            println!(
                "neo4j reachable={} version={} edition={}",
                r.reachable, r.version, r.edition
            );
            Ok(())
        }
        Commands::Purge {
            repo,
            federation,
            path,
        } => {
            let store = reposkein_neo4j_io::Neo4jStore::from_env()?;
            if federation {
                let root = resolve_repo_id(&path, repo);
                let mut ids = std::collections::BTreeSet::new();
                federation_repo_ids(&path, &root, &mut ids);
                let mut total = 0u64;
                for id in &ids {
                    total += store.purge(id)?;
                }
                println!(
                    "purged federation ({} repos, {total} nodes): {:?}",
                    ids.len(),
                    ids
                );
            } else if let Some(id) = repo {
                let n = store.purge(&id)?;
                println!("purged {n} nodes for repo_id={id}");
            } else {
                anyhow::bail!("purge requires --repo <id> or --federation");
            }
            Ok(())
        }
        Commands::Init { path, hooks } => {
            if !hooks {
                println!("nothing to do (pass --hooks to install git hooks)");
                return Ok(());
            }
            let hooks_dir = path.join(".git").join("hooks");
            std::fs::create_dir_all(&hooks_dir)
                .context("create .git/hooks (is this a git repo?)")?;
            let write_hook = |name: &str, body: &str| -> Result<()> {
                let p = hooks_dir.join(name);
                std::fs::write(&p, body).with_context(|| format!("write hook {name}"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755))?;
                }
                Ok(())
            };
            write_hook("pre-commit", PRE_COMMIT)?;
            write_hook("post-merge", POST_MERGE)?;
            write_hook("post-checkout", POST_MERGE)?; // same action as post-merge

            // .gitattributes (append idempotently).
            let attrs_path = path.join(".gitattributes");
            let existing = std::fs::read_to_string(&attrs_path).unwrap_or_default();
            let lines = [
                ".reposkein/nodes.jsonl merge=reposkein-jsonl",
                ".reposkein/edges.jsonl merge=reposkein-jsonl",
            ];
            let mut attrs = existing.clone();
            if !attrs.is_empty() && !attrs.ends_with('\n') {
                attrs.push('\n');
            }
            for l in lines {
                if !existing.contains(l) {
                    attrs.push_str(l);
                    attrs.push('\n');
                }
            }
            std::fs::write(&attrs_path, attrs).context("write .gitattributes")?;

            // Register the merge driver (kind inferred from filename at merge time).
            let run_cfg = |k: &str, v: &str| {
                std::process::Command::new("git")
                    .arg("-C")
                    .arg(&path)
                    .args(["config", k, v])
                    .status()
            };
            run_cfg(
                "merge.reposkein-jsonl.name",
                "RepoSkein canonical JSONL merge",
            )?;
            run_cfg(
                "merge.reposkein-jsonl.driver",
                "reposkein-indexer merge-jsonl %O %A %B",
            )?;

            println!(
                "installed reposkein git hooks + merge driver in {}",
                path.display()
            );
            Ok(())
        }
        Commands::MergeJsonl {
            kind,
            base,
            ours,
            theirs,
        } => {
            let read = |p: &PathBuf| -> Result<String> {
                std::fs::read_to_string(p).with_context(|| format!("read {}", p.display()))
            };
            let (b, o, t) = (read(&base)?, read(&ours)?, read(&theirs)?);
            let kind = kind.unwrap_or_else(|| {
                if ours.to_string_lossy().contains("edges") {
                    "edges".to_string()
                } else {
                    "nodes".to_string()
                }
            });
            let merged = match kind.as_str() {
                "nodes" => {
                    let m = reposkein_core::merge::merge_nodes(
                        &reposkein_core::jsonl::read_nodes(&b)?,
                        &reposkein_core::jsonl::read_nodes(&o)?,
                        &reposkein_core::jsonl::read_nodes(&t)?,
                    );
                    reposkein_core::jsonl::nodes_to_jsonl(&m)
                }
                "edges" => {
                    let m = reposkein_core::merge::merge_edges(
                        &reposkein_core::jsonl::read_edges(&b)?,
                        &reposkein_core::jsonl::read_edges(&o)?,
                        &reposkein_core::jsonl::read_edges(&t)?,
                    );
                    reposkein_core::jsonl::edges_to_jsonl(&m)
                }
                _ => unreachable!("clap restricts kind"),
            };
            std::fs::write(&ours, merged).with_context(|| format!("write {}", ours.display()))?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_remote;

    #[test]
    fn remote_schemes_normalize_equal() {
        let https = normalize_remote("https://github.com/reposkein/reposkein.git");
        let ssh = normalize_remote("git@github.com:reposkein/reposkein.git");
        let ssh2 = normalize_remote("ssh://git@github.com/reposkein/reposkein.git");
        assert_eq!(https, "github.com/reposkein/reposkein");
        assert_eq!(https, ssh);
        assert_eq!(https, ssh2);
    }
}
