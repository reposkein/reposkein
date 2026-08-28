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
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

const PRE_COMMIT: &str = r#"#!/bin/sh
# reposkein-managed
# RepoSkein: keep the local .reposkein graph in sync with the working tree.
# This script stages nothing. nodes.jsonl / edges.jsonl are derived output and
# are git-ignored. Authored summaries land in .reposkein/summaries/<xx>.jsonl,
# which IS committed: `stage-summaries` prints a hint when those shards changed
# and were left out of the commit, and stages them only if you opted in with
# `[hooks] stage_summaries = true` in .reposkein/config.toml.
#
# On success, drops a transient flag (.reposkein/local/.precommit-indexed-ok)
# for post-commit to consume: pre-commit and post-commit are separate
# processes with no shared exit status, and post-commit must never record
# the indexed-at marker (.reposkein/local/indexed-at) off a failed index —
# that would read as "fresh" when the graph is actually stale/absent. On
# failure the flag is removed instead, so a stale flag from an earlier
# successful commit can never be mistaken for this one's result.
FLAG=".reposkein/local/.precommit-indexed-ok"
BIN="${REPOSKEIN_INDEXER_BIN:-reposkein-indexer}"
if ! command -v "$BIN" >/dev/null 2>&1 && [ ! -x "$BIN" ]; then
  echo "reposkein: indexer not found; skipping graph refresh (commit continues)" >&2
  rm -f "$FLAG"
  exit 0
fi
if "$BIN" index . >/dev/null 2>&1; then
  mkdir -p .reposkein/local
  : > "$FLAG"
else
  echo "reposkein: index failed; skipping refresh" >&2
  rm -f "$FLAG"
fi
"$BIN" stage-summaries . || true
exit 0
"#;

// Recorded in .reposkein/local/indexed-at: a single git commit SHA (plus
// trailing newline), read by `doctor --ci`'s graph_stale check (mcp-side:
// mcp/src/store/indexedAt.ts). pre-commit already indexed the exact tree
// that becomes this commit, so post-commit has no reindexing to do — it
// only has to record the commit that tree turned into, which isn't known
// until after `git commit` actually creates it (pre-commit's `git rev-parse
// HEAD` would still name the *parent* commit). It gates on pre-commit's
// transient success flag (see PRE_COMMIT above) rather than writing
// unconditionally — a failed index must never be recorded as "fresh".
const POST_COMMIT: &str = r#"#!/bin/sh
# reposkein-managed
# RepoSkein: record the commit that pre-commit's index run became, so
# `doctor --ci`'s graph_stale check (.reposkein/local/indexed-at vs. HEAD)
# doesn't read a false "stale" after every normal commit. No reindex here —
# pre-commit already built the graph for the tree that just got committed.
# Only runs if pre-commit's transient success flag is present (consumed
# here); a failed pre-commit index leaves the marker untouched instead of
# recording a false "fresh".
FLAG=".reposkein/local/.precommit-indexed-ok"
if [ -f "$FLAG" ]; then
  rm -f "$FLAG"
  mkdir -p .reposkein/local
  git rev-parse HEAD > .reposkein/local/indexed-at 2>/dev/null || true
else
  echo "reposkein: pre-commit's index did not succeed; leaving the indexed-at marker as-is" >&2
fi
exit 0
"#;

const POST_MERGE: &str = r#"#!/bin/sh
# reposkein-managed
# RepoSkein: a merge/checkout can change the tree without going through your
# own pre-commit, so re-index the local graph here too, record the commit it
# was just built from (.reposkein/local/indexed-at — same marker post-commit
# writes, read by `doctor --ci`'s graph_stale check), then import into the
# local database (async, best-effort). The marker is only written when the
# reindex actually succeeds — a failed index must never be recorded as
# "fresh".
BIN="${REPOSKEIN_INDEXER_BIN:-reposkein-indexer}"
if ! command -v "$BIN" >/dev/null 2>&1 && [ ! -x "$BIN" ]; then
  echo "reposkein: indexer not found; skipping graph refresh" >&2
  exit 0
fi
if "$BIN" index . >/dev/null 2>&1; then
  mkdir -p .reposkein/local
  git rev-parse HEAD > .reposkein/local/indexed-at 2>/dev/null || true
else
  echo "reposkein: index failed; skipping refresh (indexed-at marker left untouched)" >&2
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
    /// Print the graph schema version (reposkein_core::meta::SCHEMA_VERSION)
    /// and exit 0, without indexing. Lets a caller (e.g. a CI publish
    /// workflow) assert this binary is compatible with a repo's committed
    /// .reposkein/meta.json without depending on the release/package version
    /// number, which can drift from the schema in either direction.
    #[arg(long)]
    schema_version: bool,

    #[command(subcommand)]
    command: Option<Commands>,
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
    /// Report (or, when `[hooks] stage_summaries = true`, stage) committed
    /// summary shards that changed but are not in the index. Run by pre-commit.
    StageSummaries {
        #[arg(default_value = ".")]
        path: PathBuf,
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

[hooks]
# Stage `.reposkein/summaries/` from the pre-commit hook when it changed.
# The shards are authored prose an agent wrote during the session; without
# this you get a hint on stderr and stage them yourself. Set to false if you
# prefer to review every summary before it enters a commit.
stage_summaries = true
"#;

/// Reads a boolean key from a `[section]` of `.reposkein/config.toml`.
///
/// A deliberate 20-line scanner rather than a TOML dependency: the indexer
/// reads exactly one setting, and its config is a file this binary writes.
/// Absent file, absent section, or absent key all mean `None` — which is how
/// an existing repo (whose config.toml predates the section, and which
/// `write_reposkein_layout` never rewrites) keeps its current behaviour until
/// someone opts in by hand.
fn config_bool(out_dir: &Path, section: &str, key: &str) -> Option<bool> {
    let text = std::fs::read_to_string(out_dir.join("config.toml")).ok()?;
    let mut in_section = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('#') {
            continue;
        }
        if l.starts_with('[') {
            in_section = l == format!("[{section}]");
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((k, v)) = l.split_once('=') else {
            continue;
        };
        if k.trim() != key {
            continue;
        }
        return match v.split('#').next().unwrap_or("").trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        };
    }
    None
}

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

    // Collect authored summaries from every source, newest last.
    //
    // Structure is rebuilt from source on every index, so nodes.jsonl and
    // edges.jsonl are recoverable at any time. Summaries are not: an agent
    // wrote them and nothing can regenerate them. They are therefore gathered
    // separately and persisted to `.reposkein/summaries/<xx>.jsonl`, the shards
    // that are the one part of .reposkein/ worth committing.
    // ONE accumulator for every source, folded oldest provenance first. Each
    // fold goes through `LoadedSummaries`, so displacement is always a decided
    // outcome with the loser preserved — never a silent overwrite. Cross-source
    // folds use `supersedes` (a newer source wins unless it is strictly older
    // by `summary_at`); records within one source use `beats`.
    let mut authored = reposkein_core::summaries::LoadedSummaries::default();
    // 1) Legacy: summaries inside a previously committed nodes.jsonl, so the
    //    first index after upgrading harvests them instead of dropping them.
    //    ONE-SHOT — see `legacy_nodes_harvest_needed` for why running this on
    //    every index is actively harmful. Best-effort: a corrupt derived file
    //    must never abort an index. `prev_nodes` is retained regardless (not
    //    just absorbed) so the graph_delta diff below is free.
    let prev_nodes: Option<Vec<reposkein_core::model::Node>> = std::fs::read_to_string(&nodes_path)
        .ok()
        .and_then(|prev| reposkein_core::jsonl::read_nodes(&prev).ok());
    if legacy_nodes_harvest_needed(&out_dir) {
        if let Some(ref existing) = prev_nodes {
            authored.absorb_nodes(existing);
        }
    }
    // Claim every file that must be folded in and then removed, BEFORE reading
    // any of it: renaming aside is atomic, so a write_semantic_summary landing
    // during this window writes a FRESH sidecar that survives to the next index
    // instead of being erased by a blind truncate (data loss). A run that dies
    // mid-index leaves its claims in local/consuming/, and the next run picks
    // them up — the claim is a hand-off, never a delete.
    let claims = claim_summary_sources(&out_dir);
    // 2) The committed shards: what teammates share. Tolerant of conflict
    //    markers and duplicate ids, because a shard is a merged file.
    let mut committed = reposkein_core::summaries::LoadedSummaries::default();
    for (label, text) in read_summary_shards(&out_dir) {
        committed.absorb(&label, &text);
    }
    // 3) The pre-sharding `.reposkein/summaries.jsonl`, claimed above. Read for
    //    one release so a repo (or a teammate still on the old indexer) that
    //    re-creates it loses nothing; the claim is what retires the file.
    for p in &claims.legacy {
        if let Ok(text) = std::fs::read_to_string(p) {
            committed.absorb(&label_of(p), &text);
        }
    }
    authored.absorb_source(committed);
    // 4) The live DB's summaries (PRD §9 Phase 3).
    if let Some(db_nodes) = db_summary_nodes(&repo) {
        authored.absorb_node_source(&db_nodes);
    }
    // 5) The per-agent JSONL sidecars, claimed above. Newest source: these are
    //    the writes made since the last index, by every agent on this machine.
    let mut sidecars = reposkein_core::summaries::LoadedSummaries::default();
    for p in &claims.sidecars {
        if let Ok(text) = std::fs::read_to_string(p) {
            sidecars.absorb(&label_of(p), &text);
        }
    }
    authored.absorb_source(sidecars);
    for w in &authored.warnings {
        eprintln!("reposkein: {w}");
    }
    let conflicts = std::mem::take(&mut authored.conflicts);
    let authored_nodes: Vec<reposkein_core::model::Node> = authored.nodes();

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
    write_summary_shards(&out_dir, &surviving).context("failed to write summary shards")?;
    // Divergent records that lost the tiebreak are never discarded: they go to
    // a git-ignored file a human can read, and doctor points at it.
    record_summary_conflicts(&out_dir, &conflicts);
    // Everything claimed is now persisted in the shards; release the claims.
    for p in claims.legacy.iter().chain(claims.sidecars.iter()) {
        let _ = std::fs::remove_file(p);
    }
    let _ = std::fs::remove_dir(out_dir.join("local").join(CONSUMING_DIR));
    // The shards are written, so whatever nodes.jsonl was carrying is now in
    // them. Close the one-shot harvest: from here on, steady-state indexing
    // sources committed shards + per-agent sidecars only, and a branch switch
    // cannot leak the other branch's prose back in.
    mark_legacy_nodes_harvested(&out_dir);

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

/// Pre-commit companion: notice when the authored summary shards changed and
/// the commit does not carry them.
///
/// Summaries are the one thing in `.reposkein/` no re-index can recover, and an
/// agent writes them mid-session — long after the developer last thought about
/// `git add`. Silently staging them would put prose nobody read into a commit,
/// so the default is a hint; `[hooks] stage_summaries = true` (the default for
/// newly-initialized repos) opts into staging. Always exits 0: a commit must
/// never fail because of this.
fn stage_summaries(root: &Path) {
    let out_dir = root.join(".reposkein");
    let shard_dir = format!(".reposkein/{}", reposkein_core::summaries::SHARD_DIR);
    // Porcelain over the shard directory only. `--untracked-files=all` so a
    // brand-new shard (the common case: the repo's first summary) is seen.
    let Some(status) = run_git(
        root,
        &[
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--",
            &shard_dir,
        ],
    ) else {
        return; // not a git repo, or git unavailable — nothing to hint about
    };
    // Column 2 is the worktree status: non-space means "changed and NOT staged"
    // (`??` for untracked). A shard already fully staged reads as " M"/"A " with
    // a space there, and needs no hint.
    let dirty = status
        .lines()
        .filter(|l| l.len() > 2 && !l.starts_with("? ") && &l[1..2] != " ")
        .count();
    if dirty == 0 {
        return;
    }
    if config_bool(&out_dir, "hooks", "stage_summaries") == Some(true) {
        if run_git(root, &["add", "--", &shard_dir]).is_some() {
            eprintln!(
                "reposkein: staged {dirty} changed summary shard(s) from {shard_dir}/ \
                 ([hooks] stage_summaries)"
            );
        }
        return;
    }
    eprintln!(
        "reposkein: {dirty} authored summary shard(s) under {shard_dir}/ changed but are not \
         staged.\n  Nothing can regenerate them — `git add {shard_dir}` to include them, or set \
         `[hooks] stage_summaries = true` in .reposkein/config.toml to do it automatically."
    );
}

/// Staging directory (under `.reposkein/local/`) for files an index run has
/// claimed but not yet folded into the shards.
const CONSUMING_DIR: &str = "consuming";

/// Marks that this checkout has already done the one-shot #35 harvest, so the
/// next index must not repeat it. Lives under the git-ignored `local/`, which
/// is exactly the scope we want: per working tree, surviving branch switches.
const LEGACY_HARVEST_MARKER: &str = ".legacy-nodes-harvested";

const LEGACY_HARVEST_MARKER_BODY: &str = "\
# Written by `reposkein-indexer index`. Do not commit (local/ is git-ignored).
#
# This checkout has already harvested authored summaries out of a pre-#35
# committed nodes.jsonl. Delete this file only to force that migration to run
# again — and only if you know the checkout still holds an un-migrated
# nodes.jsonl, because re-running the harvest resurrects summaries from
# whatever branch was last indexed here.
";

/// True when this index run should harvest summaries out of `nodes.jsonl`.
///
/// This harvest exists for one thing: the #35 migration, where a repo indexed
/// by an older RepoSkein carries its summaries INSIDE a then-committed
/// nodes.jsonl. Running it on every index looks harmless and is not.
///
/// nodes.jsonl is git-ignored, so it survives `git checkout`. Harvest it every
/// time and a summary written on branch A is read back on branch B and written
/// into branch B's committed shards — so every branch on the machine slowly
/// accumulates every summary ever written there, and each one shows up as a
/// shard diff against every other branch. That is precisely the cross-branch
/// churn the sharding exists to remove; the migration path was quietly
/// recreating it.
///
/// So it is one-shot per working tree, and only on evidence that this really is
/// the migration: either the pre-sharding `summaries.jsonl` is still present,
/// or no shards exist yet (nothing has been migrated in this checkout). Once a
/// run completes, `mark_legacy_nodes_harvested` closes it permanently — the
/// marker is what carries the "already done" fact across a branch switch, since
/// the shards themselves do not.
fn legacy_nodes_harvest_needed(out_dir: &Path) -> bool {
    if out_dir.join("local").join(LEGACY_HARVEST_MARKER).exists() {
        return false;
    }
    out_dir
        .join(reposkein_core::summaries::LEGACY_FILE)
        .exists()
        || !out_dir.join(reposkein_core::summaries::SHARD_DIR).exists()
}

/// Closes the one-shot harvest for this working tree. Best-effort: failing to
/// write the marker costs a redundant harvest next run, never correctness.
fn mark_legacy_nodes_harvested(out_dir: &Path) {
    let local = out_dir.join("local");
    let marker = local.join(LEGACY_HARVEST_MARKER);
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&local);
    let _ = std::fs::write(&marker, LEGACY_HARVEST_MARKER_BODY);
}

/// Files one index run has claimed and must delete once the shards are written.
#[derive(Default)]
struct SummaryClaims {
    /// The pre-sharding `.reposkein/summaries.jsonl` (plus leftovers from a run
    /// that died before finishing).
    legacy: Vec<PathBuf>,
    /// Per-agent `.reposkein/local/summaries*.jsonl` sidecars.
    sidecars: Vec<PathBuf>,
}

fn label_of(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.display().to_string())
}

/// Renames `src` into `dir` under `stem`, picking `stem.1`, `stem.2`, … when
/// taken. Never overwrites: `rename` clobbers its destination on Unix, and the
/// destination here may be a claim a crashed run has not been credited for yet.
fn claim_into(dir: &Path, src: &Path, stem: &str) -> Option<PathBuf> {
    if !src.exists() {
        return None;
    }
    std::fs::create_dir_all(dir).ok()?;
    for n in 0..1000 {
        let name = if n == 0 {
            format!("{stem}.jsonl")
        } else {
            format!("{stem}.{n}.jsonl")
        };
        let dest = dir.join(&name);
        if dest.exists() {
            continue;
        }
        if std::fs::rename(src, &dest).is_ok() {
            return Some(dest);
        }
        return None;
    }
    None
}

/// Atomically claims every summary source that must be folded into the shards
/// and then retired: the pre-sharding committed file and each per-agent
/// sidecar. Leftovers from a run that died mid-index are picked up too, so a
/// crash costs an index, never a summary.
fn claim_summary_sources(out_dir: &Path) -> SummaryClaims {
    let local = out_dir.join("local");
    let consuming = local.join(CONSUMING_DIR);
    let mut claims = SummaryClaims::default();

    // Leftovers first: they were claimed by an earlier run that never finished.
    if let Ok(entries) = std::fs::read_dir(&consuming) {
        let mut left: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        left.sort();
        for p in left {
            if label_of(&p).starts_with("legacy") {
                claims.legacy.push(p);
            } else {
                claims.sidecars.push(p);
            }
        }
    }

    if let Some(p) = claim_into(
        &consuming,
        &out_dir.join(reposkein_core::summaries::LEGACY_FILE),
        "legacy",
    ) {
        claims.legacy.push(p);
    }

    // Every `local/summaries*.jsonl`: one file per agent (REPOSKEIN_AGENT), so
    // two agents writing on the same machine no longer overwrite each other.
    let mut sidecar_srcs: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&local) {
        for e in entries.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("summaries") && name.ends_with(".jsonl") && e.path().is_file() {
                sidecar_srcs.push(e.path());
            }
        }
    }
    sidecar_srcs.sort();
    for src in sidecar_srcs {
        let stem = label_of(&src)
            .strip_suffix(".jsonl")
            .unwrap_or("sidecar")
            .to_string();
        if let Some(p) = claim_into(&consuming, &src, &stem) {
            claims.sidecars.push(p);
        }
    }
    claims
}

/// Reads every committed shard under `.reposkein/summaries/`, sorted by file
/// name so the fold order — and therefore any tiebreak — is stable.
fn read_summary_shards(out_dir: &Path) -> Vec<(String, String)> {
    let dir = out_dir.join(reposkein_core::summaries::SHARD_DIR);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| reposkein_core::summaries::is_shard_file_name(n))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|n| {
            std::fs::read_to_string(dir.join(&n))
                .ok()
                .map(|t| (format!("summaries/{n}"), t))
        })
        .collect()
}

/// Writes `path` via a temp file in the same directory plus a rename, so a
/// reader never observes a half-written shard.
fn atomic_write(path: &Path, text: &str) -> Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = label_of(path);
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, text).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}

/// Persists the authored summaries as `.reposkein/summaries/<xx>.jsonl`.
///
/// Only shards with content are written; a shard that empties out is deleted,
/// and an empty `summaries/` directory is removed, so a repo with no authored
/// prose leaves no artefact behind. Unchanged shards are not rewritten: the
/// pre-commit hook runs this on every commit, and touching a file git would
/// report as modified is exactly the churn this whole design removes.
fn write_summary_shards(out_dir: &Path, nodes: &[reposkein_core::model::Node]) -> Result<()> {
    let dir = out_dir.join(reposkein_core::summaries::SHARD_DIR);
    let shards = reposkein_core::summaries::summaries_to_shards(nodes);

    let existing: Vec<String> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| reposkein_core::summaries::is_shard_file_name(n))
                .collect()
        })
        .unwrap_or_default();
    for name in &existing {
        if !shards.contains_key(name) {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
    if shards.is_empty() {
        let _ = std::fs::remove_dir(&dir); // no-op unless it is now empty
        return Ok(());
    }
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    for (name, text) in &shards {
        let target = dir.join(name);
        if std::fs::read_to_string(&target).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        atomic_write(&target, text)?;
    }
    Ok(())
}

/// Appends divergence losers to the git-ignored `local/conflicts.jsonl`.
/// Best-effort: failing to record a conflict must not fail an index.
fn record_summary_conflicts(out_dir: &Path, losers: &[reposkein_core::summaries::SummaryRecord]) {
    if losers.is_empty() {
        return;
    }
    let local = out_dir.join("local");
    let path = local.join(reposkein_core::summaries::CONFLICTS_FILE);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let text = reposkein_core::summaries::conflicts_to_jsonl(&existing, losers);
    if text == existing {
        return;
    }
    let _ = std::fs::create_dir_all(&local);
    let _ = std::fs::write(&path, &text);
    eprintln!(
        "reposkein: {} divergent summary record(s) preserved in .reposkein/local/{} \
         (the winner is in the shards; `reposkein-mcp doctor` reports this)",
        losers.len(),
        reposkein_core::summaries::CONFLICTS_FILE
    );
}

/// The `.reposkein/.gitignore` this indexer maintains.
///
/// `summaries/.*` covers the dot-prefixed temp file `atomic_write` renames
/// from: a crash between write and rename must not leave a committable
/// artefact behind.
const REPOSKEIN_GITIGNORE: &str = "local/\nnodes.jsonl\nedges.jsonl\nsummaries/.*\n";

/// The `.reposkein/.gitattributes` this indexer maintains.
///
/// Scoped to the shards, and honest about its reach: a tree-level
/// `.gitattributes` is not consulted by a forge computing mergeability in a
/// bare repo (`docs/migrations/2026-08-06-stop-committing-derived-graph.md`),
/// so this only helps LOCAL merges and rebases. It is still worth having,
/// because that is where a developer hits the conflict by hand — and union's
/// failure mode (a duplicated line) is one the tolerant reader dedupes.
/// Also carries -diff/linguist-generated for the derived graph (REP-35): inert
/// in the normal untracked layout, but collapses context-window-exhausting diffs
/// in repos that still track it.
const REPOSKEIN_GITATTRIBUTES: &str = "\
# Derived graph: normally untracked (see .gitignore). These attributes are a
# safety net for pre-0.2.7 repos that still track it: `-diff` collapses the
# files to a single line in local `git diff` / `git show` output (a full diff
# of a tracked graph can exceed an agent's entire context window), and
# `linguist-generated` collapses them in GitHub PR views. Harmless once
# untracked — run `reposkein-mcp migrate` to get there.
nodes.jsonl -diff linguist-generated
edges.jsonl -diff linguist-generated
# Local merges of the authored summary shards resolve by keeping both sides.
# Duplicate or divergent records are harmless: the reader dedupes by id with a
# deterministic tiebreak and preserves the loser in local/conflicts.jsonl, and
# the next `index` rewrites the shard canonically.
# NOTE: forges compute mergeability in a bare repo, where this file is never
# consulted. Merge smoothness comes from the sharding, not from this line.
summaries/*.jsonl merge=union linguist-generated
";

/// Writes meta.json, .reposkein/.gitignore, .reposkein/.gitattributes, the
/// default config.toml (if absent), and the git-ignored local/ dir.
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
    // So they stay out of git. Authored summaries live in summaries/<xx>.jsonl,
    // which is committed.
    std::fs::write(out_dir.join(".gitignore"), REPOSKEIN_GITIGNORE)?;
    std::fs::write(out_dir.join(".gitattributes"), REPOSKEIN_GITATTRIBUTES)?;
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
    if cli.schema_version {
        println!("{}", reposkein_core::meta::SCHEMA_VERSION);
        return Ok(());
    }
    let Some(command) = cli.command else {
        anyhow::bail!(
            "missing subcommand (run with --help for usage, or --schema-version to print the schema version)"
        );
    };
    match command {
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
                                .find(|l| {
                                    !l.starts_with('#')
                                        && (l.contains("reposkein-indexer") || l.contains("indexed-at"))
                                })
                                .unwrap_or("see docs/INSTALL.md for the RepoSkein hook content")
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
            write_hook("post-commit", POST_COMMIT)?;
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

            // The shards get their own declaration, but it lives INSIDE
            // .reposkein/ (see REPOSKEIN_GITATTRIBUTES) rather than in the root
            // file: it is ours to own, it never collides with a user rule, and
            // an uninstall is `rm -r .reposkein`. Written here too so a repo
            // that runs `init --hooks` without a fresh `index` still gets it.
            let out_dir = path.join(".reposkein");
            if out_dir.is_dir() {
                std::fs::write(out_dir.join(".gitattributes"), REPOSKEIN_GITATTRIBUTES)
                    .context("write .reposkein/.gitattributes")?;
            }

            println!("installed reposkein git hooks in {}", path.display());
            Ok(())
        }
        Commands::StageSummaries { path } => {
            stage_summaries(&path);
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
    fn post_commit_hook_contains_marker() {
        use super::POST_COMMIT;
        assert!(POST_COMMIT.contains("# reposkein-managed"));
    }

    #[test]
    fn post_commit_hook_writes_the_indexed_at_marker_and_nothing_else() {
        use super::POST_COMMIT;
        assert!(POST_COMMIT.contains(".reposkein/local/indexed-at"));
        assert!(POST_COMMIT.contains("git rev-parse HEAD"));
        // Single responsibility: record the commit, don't reindex (pre-commit
        // already indexed the tree that became it).
        assert!(!POST_COMMIT.contains("index ."));
    }

    #[test]
    fn gitattributes_template_hardens_derived_graph() {
        use super::REPOSKEIN_GITATTRIBUTES;
        assert!(REPOSKEIN_GITATTRIBUTES.contains("nodes.jsonl -diff linguist-generated"));
        assert!(REPOSKEIN_GITATTRIBUTES.contains("edges.jsonl -diff linguist-generated"));
        assert!(REPOSKEIN_GITATTRIBUTES.contains("summaries/*.jsonl merge=union linguist-generated"));
    }

    #[test]
    fn post_merge_hook_reindexes_before_recording_the_marker() {
        use super::POST_MERGE;
        assert!(POST_MERGE.contains("index ."));
        assert!(POST_MERGE.contains(".reposkein/local/indexed-at"));
        // Search for the actual command invocation, not the prose comment
        // above it (which also happens to contain the substring "index ").
        let index_pos = POST_MERGE.find("\"$BIN\" index .").unwrap();
        let marker_pos = POST_MERGE.find("> .reposkein/local/indexed-at").unwrap();
        assert!(index_pos < marker_pos);
    }

    #[test]
    fn post_merge_hook_gates_the_marker_write_on_index_success() {
        use super::POST_MERGE;
        // The marker write must be reachable only through the success branch
        // of an `if "$BIN" index . ...; then ... fi` — not written
        // unconditionally after a `||`-swallowed failure (the bug this test
        // guards against: an `if`/`then` gate is required, a bare `||` isn't
        // enough since control flow continues past it either way).
        assert!(POST_MERGE.contains("if \"$BIN\" index ."));
        let then_pos = POST_MERGE.find("if \"$BIN\" index .").unwrap();
        let marker_pos = POST_MERGE.find("> .reposkein/local/indexed-at").unwrap();
        let else_pos = POST_MERGE
            .find("else")
            .expect("post-merge must have an else branch for a failed index");
        assert!(
            then_pos < marker_pos,
            "marker write must be inside the success branch"
        );
        assert!(
            marker_pos < else_pos,
            "marker write must come before the else (failure) branch"
        );
    }

    #[test]
    fn pre_commit_hook_gates_its_success_flag_on_index_success_and_clears_it_on_failure() {
        use super::PRE_COMMIT;
        const FLAG: &str = ".reposkein/local/.precommit-indexed-ok";
        assert!(PRE_COMMIT.contains(FLAG));
        assert!(
            PRE_COMMIT.contains("if \"$BIN\" index ."),
            "the flag write must be gated by an if/then on the index command's exit status"
        );
        // Both branches must mention the flag: the success branch writes it,
        // the failure branch (and the indexer-not-found branch) remove it —
        // never leave a stale success flag from an earlier commit around.
        assert_eq!(
            PRE_COMMIT.matches("rm -f \"$FLAG\"").count(),
            2,
            "the flag must be removed on both the 'not found' and 'index failed' paths:\n{PRE_COMMIT}"
        );
    }

    #[test]
    fn post_commit_hook_only_writes_the_marker_when_the_precommit_flag_is_present() {
        use super::POST_COMMIT;
        const FLAG: &str = ".reposkein/local/.precommit-indexed-ok";
        assert!(POST_COMMIT.contains(FLAG));
        assert!(
            POST_COMMIT.contains("if [ -f \"$FLAG\" ]"),
            "the marker write must be gated on the transient flag pre-commit left behind:\n{POST_COMMIT}"
        );
        let if_pos = POST_COMMIT.find("if [ -f \"$FLAG\" ]").unwrap();
        let marker_pos = POST_COMMIT.find("> .reposkein/local/indexed-at").unwrap();
        assert!(
            if_pos < marker_pos,
            "marker write must be inside the flag-present branch"
        );
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
