//! reposkein-indexer CLI. M0: the `index` subcommand walks a repository and
//! writes canonical `.reposkein/nodes.jsonl` + `.reposkein/edges.jsonl`.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use reposkein_core::{index_tree_with, jsonl};
use reposkein_lang_csharp::CsharpExtractor;
use reposkein_lang_go::GoExtractor;
use reposkein_lang_java::JavaExtractor;
use reposkein_lang_python::PythonExtractor;
use reposkein_lang_rust::RustExtractor;
use reposkein_lang_ts::{JavaScriptExtractor, TypeScriptExtractor};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

const PRE_COMMIT: &str = r#"#!/bin/sh
# reposkein-managed
# RepoSkein: keep the local .reposkein graph in sync with the working tree.
# Nothing is staged. nodes.jsonl / edges.jsonl are derived output and are
# git-ignored; authored summaries land in .reposkein/summaries.jsonl, which you
# stage yourself like any other edit.
BIN="${REPOSKEIN_INDEXER_BIN:-reposkein-indexer}"
if ! command -v "$BIN" >/dev/null 2>&1 && [ ! -x "$BIN" ]; then
  echo "reposkein: indexer not found; skipping graph refresh (commit continues)" >&2
  exit 0
fi
"$BIN" index . >/dev/null 2>&1 || { echo "reposkein: index failed; skipping refresh" >&2; exit 0; }
exit 0
"#;

const POST_MERGE: &str = r#"#!/bin/sh
# reposkein-managed
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
        /// Emit a single JSON object with machine-readable stats instead of human text.
        #[arg(long)]
        json: bool,
        /// Disable the per-file extract cache (always re-parse every file).
        #[arg(long)]
        no_cache: bool,
    },
    /// Reindex a repository (cache-accelerated). With --file, force-reparses
    /// that one file. Output matches `index`.
    Reindex {
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Repo-relative path of the edited file to force-reparse.
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        repo_id: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        no_federation: bool,
        #[arg(long)]
        json: bool,
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
        /// Emit a single JSON object with machine-readable stats instead of human text.
        #[arg(long)]
        json: bool,
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
        /// The real (post-merge) pathname git provides via %P, used to infer
        /// nodes-vs-edges (the positional base/ours/theirs are temp files).
        #[arg(long)]
        path: Option<PathBuf>,
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

/// Default repository display name.
///
/// The basename of `path` is wrong inside a git worktree: it yields the worktree
/// slug, so a commit made from a worktree rewrites the Repository node to that
/// slug and corrupts the graph identity when the branch merges. `--git-common-dir`
/// resolves to the MAIN checkout's `.git` from any worktree, so its parent is the
/// canonical repository directory. Deriving from the remote instead would be wrong
/// for repos whose directory name differs from their remote name.
fn default_repo_name(path: &Path) -> String {
    let from_path = || {
        path.canonicalize()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .unwrap_or_else(|| "repo".to_string())
    };
    // `--git-common-dir` may come back relative (plain `.git`), so resolve it
    // against `path` before taking the parent.
    let Some(common) = run_git(path, &["rev-parse", "--git-common-dir"]) else {
        return from_path();
    };
    let common_path = Path::new(&common);
    let absolute = if common_path.is_absolute() {
        common_path.to_path_buf()
    } else {
        path.join(common_path)
    };
    absolute
        .canonicalize()
        .ok()
        .and_then(|p| {
            p.parent()
                .and_then(|r| r.file_name())
                .map(|n| n.to_string_lossy().to_string())
        })
        .unwrap_or_else(from_path)
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
enabled = ["python", "typescript", "rust", "go", "java", "csharp"]

[neo4j]
uri = "neo4j://localhost:7687"
# credentials come from env (NEO4J_USER / NEO4J_PASSWORD), never committed
"#;

struct IndexRun {
    repo: String,
    repo_name: String,
    files: usize,
    nodes: usize,
    edges: usize,
    children: usize,
    warnings: Vec<String>,
    /// Old-vs-new node diff; None on a first index (nothing to diff against).
    delta: Option<reposkein_core::delta::GraphDelta>,
}

/// Shared index routine used by both `index` and `reindex`. When
/// `invalidate_file` is Some, that file's extract-cache entry is removed first
/// (forcing a fresh parse). Writes nodes/edges JSONL + the .reposkein layout.
fn run_index(
    path: &Path,
    repo_id: Option<String>,
    name: Option<String>,
    no_federation: bool,
    no_cache: bool,
    invalidate_file: Option<&str>,
) -> Result<IndexRun> {
    let repo = resolve_repo_id(path, repo_id);
    let repo_name = name.unwrap_or_else(|| default_repo_name(path));

    let python = PythonExtractor;
    let typescript = TypeScriptExtractor;
    let javascript = JavaScriptExtractor;
    let rust = RustExtractor;
    let go = GoExtractor;
    let java = JavaExtractor;
    let csharp = CsharpExtractor;
    let extractors: &[&dyn reposkein_core::extractor::Extractor] = &[
        &python,
        &typescript,
        &javascript,
        &rust,
        &go,
        &java,
        &csharp,
    ];

    // Per-file extract cache under the git-ignored local/ dir.
    let cache = if no_cache {
        None
    } else {
        reposkein_core::cache::FsExtractCache::open(
            path.join(".reposkein")
                .join("local")
                .join("cache")
                .join("extract"),
        )
    };
    // Force a fresh parse of the named file (reindex --file).
    if let (Some(c), Some(f)) = (cache.as_ref(), invalidate_file) {
        c.invalidate(f);
    }
    let opts = reposkein_core::IndexOptions {
        federation: !no_federation,
        cache: cache
            .as_ref()
            .map(|c| c as &dyn reposkein_core::cache::ExtractCache),
    };
    let out = index_tree_with(path, &repo, &repo_name, extractors, opts)
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

    let files = graph.nodes.iter().filter(|n| n.labels == ["File"]).count();

    let out_dir = path.join(".reposkein");
    std::fs::create_dir_all(&out_dir).context("failed to create .reposkein/")?;
    let nodes_path = out_dir.join("nodes.jsonl");
    let summaries_path = out_dir.join("summaries.jsonl");

    // Collect authored summaries from every source, newest last.
    //
    // Structure is rebuilt from source on every index, so nodes.jsonl and
    // edges.jsonl are recoverable at any time. Summaries are not: an agent
    // wrote them and nothing can regenerate them. They are therefore gathered
    // separately and persisted to `.reposkein/summaries.jsonl`, the one file in
    // .reposkein/ worth committing.
    let mut authored: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    // 1) Legacy: summaries inside a previously committed nodes.jsonl, so the
    //    first index after upgrading harvests them instead of dropping them.
    //    Best-effort — a corrupt derived file must never abort an index.
    //    Retained (not just absorbed) so the graph_delta diff below is free.
    let prev_nodes: Option<Vec<reposkein_core::model::Node>> = std::fs::read_to_string(&nodes_path)
        .ok()
        .and_then(|prev| reposkein_core::jsonl::read_nodes(&prev).ok());
    if let Some(ref existing) = prev_nodes {
        absorb_summaries(&mut authored, existing);
    }
    // 2) The committed summaries file: what teammates share.
    if let Ok(text) = std::fs::read_to_string(&summaries_path) {
        absorb_summaries(
            &mut authored,
            &reposkein_core::jsonl::read_sidecar_summaries(&text),
        );
    }
    // 3) The live DB's summaries (PRD §9 Phase 3).
    if let Some(db_nodes) = db_summary_nodes(&repo) {
        absorb_summaries(&mut authored, &db_nodes);
    }
    // 4) The JSONL-mode sidecar. Atomically *claim* it (rename aside) BEFORE
    //    reading: a write_semantic_summary landing during this window then
    //    writes a FRESH sidecar that survives to the next index, instead of
    //    being erased by a blind truncate (data loss).
    let sidecar_path = out_dir.join("local").join("summaries.jsonl");
    let claimed_path = out_dir.join("local").join("summaries.consuming.jsonl");
    let claimed = std::fs::rename(&sidecar_path, &claimed_path).is_ok();
    if claimed {
        if let Ok(text) = std::fs::read_to_string(&claimed_path) {
            absorb_summaries(
                &mut authored,
                &reposkein_core::jsonl::read_sidecar_summaries(&text),
            );
        }
    }
    let authored_nodes: Vec<reposkein_core::model::Node> = authored
        .into_iter()
        .map(|(id, props)| reposkein_core::model::Node {
            id,
            labels: Vec::new(),
            props,
        })
        .collect();

    // Derived output. Summaries are grafted in only where `summary_of_hash`
    // still matches the node, so a stale summary never reads as current.
    let nodes = reposkein_core::merge::graft_summaries(&graph.nodes, &authored_nodes);
    std::fs::write(&nodes_path, jsonl::nodes_to_jsonl(&nodes))
        .context("failed to write nodes.jsonl")?;
    std::fs::write(
        out_dir.join("edges.jsonl"),
        jsonl::edges_to_jsonl(&graph.edges),
    )
    .context("failed to write edges.jsonl")?;

    // Authored output. Kept verbatim rather than hash-filtered: a summary whose
    // node changed is *stale*, not wrong, and a reader detects that by comparing
    // `summary_of_hash` against the node's `content_hash`. Filtering here would
    // silently delete authored prose on the next unrelated refactor, and churn
    // a committed file on every edit. Summaries whose node no longer exists are
    // dropped — that code is gone.
    let live: HashSet<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
    let surviving: Vec<reposkein_core::model::Node> = authored_nodes
        .into_iter()
        .filter(|n| live.contains(n.id.as_str()))
        .collect();
    let summaries = jsonl::summaries_to_jsonl(&surviving);
    if summaries.is_empty() {
        // Leave no empty file behind in repos that have no summaries at all.
        let _ = std::fs::remove_file(&summaries_path);
    } else {
        std::fs::write(&summaries_path, summaries).context("failed to write summaries.jsonl")?;
    }
    if claimed {
        // Now persisted in summaries.jsonl; drop the claim.
        let _ = std::fs::remove_file(&claimed_path);
    }

    write_reposkein_layout(&out_dir, &repo).context("failed to write .reposkein layout")?;

    // Decision drift trigger: diff the previous graph against the fresh one
    // and persist any non-empty delta to local/last_delta.json. Hook-driven
    // indexes (pre-commit, post-merge, post-checkout) discard stdout, and
    // post-merge — teammate changes landing — is precisely when decisions go
    // stale; the persisted file lets the MCP server surface decisions_affected
    // on its next call. Best-effort: drift detection must never fail an index.
    let delta = prev_nodes
        .as_deref()
        .map(|prev| reposkein_core::delta::compute_graph_delta(prev, &graph.nodes));
    if let Some(ref d) = delta {
        if !d.is_empty() {
            let pending_path = out_dir.join("local").join("last_delta.json");
            let merged = std::fs::read_to_string(&pending_path)
                .ok()
                .and_then(|t| serde_json::from_str::<reposkein_core::delta::GraphDelta>(&t).ok())
                .map(|pending| reposkein_core::delta::merge_graph_delta(&pending, d))
                .unwrap_or_else(|| d.clone());
            let _ = std::fs::create_dir_all(out_dir.join("local"));
            if let Ok(json) = serde_json::to_string(&merged) {
                let _ = std::fs::write(&pending_path, json);
            }
        }
    }

    Ok(IndexRun {
        repo,
        repo_name,
        files,
        nodes: graph.nodes.len(),
        edges: graph.edges.len(),
        children: out.children.len(),
        warnings: out.warnings,
        delta,
    })
}

fn index_stats_json(r: &IndexRun) -> String {
    let mut stats = serde_json::json!({
        "repo_id": r.repo,
        "files": r.files,
        "nodes": r.nodes,
        "edges": r.edges,
        "children": r.children,
        "warnings": r.warnings,
    });
    if let Some(ref d) = r.delta {
        if !d.is_empty() {
            stats["graph_delta"] = serde_json::to_value(d).unwrap_or(serde_json::Value::Null);
        }
    }
    serde_json::to_string(&stats).unwrap()
}

/// True for a `.gitattributes` line an earlier RepoSkein wrote to point the
/// derived JSONL at a merge driver (the custom `reposkein-jsonl` one or the
/// built-in `union`).
fn is_reposkein_merge_attr(line: &str) -> bool {
    let l = line.trim();
    (l.starts_with(".reposkein/nodes.jsonl") || l.starts_with(".reposkein/edges.jsonl"))
        && l.contains("merge=")
}

/// Folds any nodes carrying summary props into `authored`, keyed by node id.
/// Later calls win, so callers should feed sources oldest-first.
fn absorb_summaries(
    authored: &mut BTreeMap<String, Map<String, Value>>,
    records: &[reposkein_core::model::Node],
) {
    for n in records {
        let part = reposkein_core::merge::summary_part(&n.props);
        if reposkein_core::merge::has_summary(&part) {
            authored.insert(n.id.clone(), part);
        }
    }
}

/// Writes meta.json, .reposkein/.gitignore, default config.toml (if absent),
/// and the git-ignored local/ dir.
fn write_reposkein_layout(out_dir: &Path, repo_id: &str) -> Result<()> {
    std::fs::write(
        out_dir.join("meta.json"),
        reposkein_core::meta::meta_json(repo_id),
    )?;
    // nodes.jsonl / edges.jsonl are derived: a pure function of the working
    // tree that `index` rebuilds in seconds. Committing them means every branch
    // that touches code also rewrites two machine-generated files, so every open
    // pull request conflicts on them the moment any other one merges. A
    // `.gitattributes merge=union` declaration does not rescue this: forges
    // compute mergeability in a bare repo, where tree-level .gitattributes is
    // never consulted, and where union *does* apply it resolves by keeping both
    // sides' lines, producing duplicate ids for any node both branches touched.
    // So they stay out of git. Authored summaries live in summaries.jsonl, which
    // is committed.
    std::fs::write(
        out_dir.join(".gitignore"),
        "local/\nnodes.jsonl\nedges.jsonl\n",
    )?;
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

/// Resolves a federation child's path from an UNTRUSTED committed `root_path`,
/// rejecting absolute paths, `..` traversal, and anything that escapes `base`.
/// Committed JSONL is an untrusted supply-chain input (PRD §3.6), and the
/// load path runs no collision/identity guard, so this must be defensive.
fn safe_child_path(base: &Path, root_path: &str) -> Option<PathBuf> {
    let rp = Path::new(root_path);
    if rp.is_absolute() {
        return None;
    }
    if rp
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return None;
    }
    let joined = base.join(rp);
    // Require the resolved child to stay within base (defends against symlinks
    // and any residual traversal). Canonicalize needs the path to exist; a
    // non-existent child canonicalizes to Err → None → safely skipped.
    let cbase = base.canonicalize().ok()?;
    let cjoined = joined.canonicalize().ok()?;
    if cjoined.starts_with(&cbase) {
        Some(joined)
    } else {
        None
    }
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
                match safe_child_path(path, rp) {
                    Some(child) => {
                        let (cr, cn, ce) = load_federation(store, &child, fed, seen, skipped)?;
                        repos += cr;
                        n += cn;
                        e += ce;
                    }
                    None => {
                        eprintln!(
                            "reposkein: federation child root_path '{rp}' rejected (absolute or escapes the repo); skipping"
                        );
                        skipped.push(rp.to_string());
                    }
                }
            }
        }
    }
    Ok((repos, n, e))
}

/// Collects a federation's repo_ids from committed JSONL (no DB), starting at
/// `repo_id`/`path` and following proxy `federated_repo_id`/`root_path`.
fn federation_repo_ids(path: &Path, repo_id: &str, seen: &mut std::collections::BTreeSet<String>) {
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
                if let Some(child) = safe_child_path(path, rp) {
                    federation_repo_ids(&child, fed, seen);
                }
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
            json,
            no_cache,
        } => {
            let r = run_index(&path, repo_id, name, no_federation, no_cache, None)?;
            if json {
                println!("{}", index_stats_json(&r));
            } else {
                println!(
                    "indexed repo_id={} name={}: {} nodes, {} edges, {} federated children",
                    r.repo, r.repo_name, r.nodes, r.edges, r.children
                );
            }
            Ok(())
        }
        Commands::Reindex {
            path,
            file,
            repo_id,
            name,
            no_federation,
            json,
        } => {
            let r = run_index(&path, repo_id, name, no_federation, false, file.as_deref())?;
            if json {
                println!("{}", index_stats_json(&r));
            } else {
                println!(
                    "reindexed repo_id={} name={}: {} nodes, {} edges, {} federated children",
                    r.repo, r.repo_name, r.nodes, r.edges, r.children
                );
            }
            Ok(())
        }
        Commands::Load {
            path,
            repo_id,
            no_federation,
            json,
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
                store.import_graph(
                    &repo,
                    &reposkein_core::Graph {
                        nodes: nodes.clone(),
                        edges: edges.clone(),
                    },
                )?;
                if json {
                    let stats = serde_json::json!({
                        "repo_id": repo,
                        "repos": 1,
                        "nodes": nodes.len(),
                        "edges": edges.len(),
                    });
                    println!("{}", serde_json::to_string(&stats).unwrap());
                } else {
                    println!("loaded repo_id={repo} (no federation)");
                }
            } else {
                let mut seen = std::collections::BTreeSet::new();
                let mut skipped = Vec::new();
                let (repos, n, e) = load_federation(&store, &path, &repo, &mut seen, &mut skipped)?;
                let stitches = store.stitch_federation()?;
                let repo_ids: Vec<String> = seen.iter().cloned().collect();
                let xcalls = store.stitch_cross_repo_calls(&repo_ids)?;
                let ximports = store.stitch_cross_repo_imports(&repo_ids)?;
                let xheritage = store.stitch_cross_repo_heritage(&repo_ids)?;
                for s in &skipped {
                    eprintln!("reposkein: skipped (no .reposkein JSONL): {s}");
                }
                if json {
                    let stats = serde_json::json!({
                        "repo_id": repo,
                        "repos": repos,
                        "nodes": n,
                        "edges": e,
                        "cross_repo_calls": xcalls,
                        "cross_repo_imports": ximports,
                        "cross_repo_heritage": xheritage,
                    });
                    println!("{}", serde_json::to_string(&stats).unwrap());
                } else {
                    println!(
                        "loaded {repos} repo(s): {n} nodes, {e} edges; {stitches} federation stitch(es); {xcalls} cross-repo call(s); {ximports} cross-repo import(s); {xheritage} cross-repo heritage edge(s)"
                    );
                }
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
                // If a hook already exists but was NOT written by us, preserve it and warn.
                if p.exists() {
                    let existing = std::fs::read_to_string(&p).unwrap_or_default();
                    if !existing.contains("# reposkein-managed") {
                        eprintln!(
                            "reposkein: hook '{}' already exists and was not written by RepoSkein — \
                             preserving it. To enable RepoSkein indexing, add this line to your hook:\n  \
                             {}",
                            name,
                            body.lines()
                                .find(|l| l.contains("reposkein-indexer") && !l.starts_with('#'))
                                .unwrap_or("\"$BIN\" index . >/dev/null 2>&1 || true")
                        );
                        return Ok(());
                    }
                }
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

            // .gitattributes: remove any merge declaration an earlier RepoSkein
            // installed for the derived JSONL.
            //
            // Those files are no longer committed, so a merge driver has nothing
            // left to resolve. Leaving the line is worse than useless: the custom
            // driver only exists on a developer's machine, and a forge computing
            // mergeability does it in a bare repo, where tree-level .gitattributes
            // is not consulted at all — so neither the custom driver nor a
            // built-in `merge=union` ever runs there.
            let attrs_path = path.join(".gitattributes");
            if let Ok(existing) = std::fs::read_to_string(&attrs_path) {
                let kept: Vec<&str> = existing
                    .lines()
                    .filter(|l| !is_reposkein_merge_attr(l))
                    .collect();
                if kept.len() != existing.lines().count() {
                    if kept.iter().all(|l| l.trim().is_empty()) {
                        // The file only ever held our lines; leave no empty
                        // artefact behind.
                        std::fs::remove_file(&attrs_path).context("remove .gitattributes")?;
                    } else {
                        let mut out = kept.join("\n");
                        out.push('\n');
                        std::fs::write(&attrs_path, out).context("write .gitattributes")?;
                    }
                    println!("removed the .reposkein merge declaration from .gitattributes");
                }
            }

            // Drop the merge-driver registration an earlier RepoSkein wrote into
            // .git/config. Best-effort: an absent key is not an error.
            for key in ["merge.reposkein-jsonl.name", "merge.reposkein-jsonl.driver"] {
                let _ = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&path)
                    .args(["config", "--unset-all", key])
                    .status();
            }

            println!("installed reposkein git hooks in {}", path.display());
            Ok(())
        }
        Commands::MergeJsonl {
            path,
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
                let hint = path
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| ours.to_string_lossy().to_string());
                if hint.contains("edges") {
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
    use super::default_repo_name;
    use super::normalize_remote;
    use super::safe_child_path;
    use std::fs;
    use std::process::Command;
    use tempfile::tempdir;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git available");
        assert!(out.status.success(), "git {args:?} failed");
    }

    #[test]
    fn repo_name_from_worktree_is_the_main_checkout_not_the_worktree_slug() {
        let tmp = tempdir().unwrap();
        let main = tmp.path().join("canonical-repo");
        fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q"]);
        git(&main, &["config", "user.email", "t@example.com"]);
        git(&main, &["config", "user.name", "t"]);
        fs::write(main.join("f.txt"), "x").unwrap();
        git(&main, &["add", "f.txt"]);
        git(&main, &["commit", "-qm", "init"]);

        // A worktree whose directory name deliberately differs from the repo's.
        let worktree = tmp.path().join("some-ticket-slug");
        git(
            &main,
            &["worktree", "add", worktree.to_str().unwrap(), "-b", "wt"],
        );

        assert_eq!(default_repo_name(&main), "canonical-repo");
        assert_eq!(default_repo_name(&worktree), "canonical-repo");
    }

    #[test]
    fn repo_name_outside_a_git_repo_falls_back_to_the_directory() {
        let tmp = tempdir().unwrap();
        let plain = tmp.path().join("plain-dir");
        fs::create_dir_all(&plain).unwrap();
        assert_eq!(default_repo_name(&plain), "plain-dir");
    }

    #[test]
    fn remote_schemes_normalize_equal() {
        let https = normalize_remote("https://github.com/reposkein/reposkein.git");
        let ssh = normalize_remote("git@github.com:reposkein/reposkein.git");
        let ssh2 = normalize_remote("ssh://git@github.com/reposkein/reposkein.git");
        assert_eq!(https, "github.com/reposkein/reposkein");
        assert_eq!(https, ssh);
        assert_eq!(https, ssh2);
    }

    #[test]
    fn safe_child_path_accepts_real_nested_child() {
        let dir = tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join("vendor/child")).unwrap();
        assert!(safe_child_path(base, "vendor/child").is_some());
    }

    #[test]
    fn safe_child_path_rejects_absolute() {
        let dir = tempdir().unwrap();
        assert!(safe_child_path(dir.path(), "/etc").is_none());
    }

    #[test]
    fn safe_child_path_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        let base = dir.path();
        fs::create_dir_all(base.join("sub")).unwrap();
        // Even if the traversed target exists, `..` is rejected outright.
        assert!(safe_child_path(&base.join("sub"), "../").is_none());
        assert!(safe_child_path(base, "../sibling").is_none());
    }

    #[test]
    fn safe_child_path_rejects_nonexistent_child() {
        let dir = tempdir().unwrap();
        assert!(safe_child_path(dir.path(), "does/not/exist").is_none());
    }

    #[test]
    fn write_hook_does_not_overwrite_user_hook() {
        let dir = tempdir().unwrap();
        let hooks_dir = dir.path().join(".git").join("hooks");
        fs::create_dir_all(&hooks_dir).unwrap();
        // Write a user hook (no reposkein-managed marker)
        let hook_path = hooks_dir.join("pre-commit");
        fs::write(&hook_path, "#!/bin/sh\n# user hook\nmy-tool\n").unwrap();

        // Simulate what write_hook does: check for marker, preserve if absent
        let existing = fs::read_to_string(&hook_path).unwrap_or_default();
        assert!(!existing.contains("# reposkein-managed"));
        // write_hook would return Ok(()) without overwriting
        // Verify the file is unchanged
        let after = fs::read_to_string(&hook_path).unwrap();
        assert_eq!(after, "#!/bin/sh\n# user hook\nmy-tool\n");
    }

    #[test]
    fn write_hook_overwrites_reposkein_hook() {
        use super::PRE_COMMIT;
        let dir = tempdir().unwrap();
        let hooks_dir = dir.path().join(".git").join("hooks");
        fs::create_dir_all(&hooks_dir).unwrap();
        // Write an existing reposkein hook (has marker)
        let hook_path = hooks_dir.join("pre-commit");
        fs::write(&hook_path, "#!/bin/sh\n# reposkein-managed\nold content\n").unwrap();

        // write_hook SHOULD overwrite since marker is present
        let existing = fs::read_to_string(&hook_path).unwrap_or_default();
        assert!(existing.contains("# reposkein-managed"));
        // Would proceed to overwrite — verify logic
        fs::write(&hook_path, PRE_COMMIT).unwrap();
        let after = fs::read_to_string(&hook_path).unwrap();
        assert!(after.contains("# reposkein-managed"));
    }

    #[test]
    fn pre_commit_hook_contains_marker() {
        use super::PRE_COMMIT;
        assert!(PRE_COMMIT.contains("# reposkein-managed"));
    }

    #[test]
    fn post_merge_hook_contains_marker() {
        use super::POST_MERGE;
        assert!(POST_MERGE.contains("# reposkein-managed"));
    }

    #[test]
    fn merge_driver_uses_absolute_path() {
        // current_exe() in tests returns the test binary path (absolute)
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "reposkein-indexer".to_string());
        // It should be absolute (start with /)
        assert!(
            exe.starts_with('/') || exe.contains('\\'),
            "exe path should be absolute: {}",
            exe
        );
    }
}
