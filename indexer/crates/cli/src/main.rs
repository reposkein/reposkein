//! reposkein-indexer CLI. M0: the `index` subcommand walks a repository and
//! writes canonical `.reposkein/nodes.jsonl` + `.reposkein/edges.jsonl`.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use reposkein_core::{index_tree, jsonl};
use reposkein_lang_python::PythonExtractor;
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
    },
    /// Load committed .reposkein JSONL into Neo4j (reconstruct the DB).
    Load {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        repo_id: Option<String>,
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
    /// Delete all graph data for a repo_id from Neo4j.
    Purge {
        #[arg(long)]
        repo: String,
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

/// repo_id = BLAKE3(first_commit_hash + "\n" + origin_url), 12 hex chars.
/// Falls back to a hash of the absolute root path when git is unavailable.
fn compute_repo_id(root: &Path) -> String {
    let first = run_git(root, &["rev-list", "--max-parents=0", "HEAD"]).unwrap_or_default();
    let remote = run_git(root, &["remote", "get-url", "origin"]).unwrap_or_default();
    let basis = if first.is_empty() && remote.is_empty() {
        root.canonicalize()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| root.to_string_lossy().to_string())
    } else {
        format!("{first}\n{remote}")
    };
    blake3::hash(basis.as_bytes()).to_hex().to_string()[..12].to_string()
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Index {
            path,
            repo_id,
            name,
        } => {
            let repo = repo_id.unwrap_or_else(|| compute_repo_id(&path));
            let repo_name = name.unwrap_or_else(|| {
                path.canonicalize()
                    .ok()
                    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                    .unwrap_or_else(|| "repo".to_string())
            });

            let python = PythonExtractor;
            let extractors: &[&dyn reposkein_core::extractor::Extractor] = &[&python];
            let graph = index_tree(&path, &repo, &repo_name, extractors)
                .context("failed to index repository tree")?;

            let out_dir = path.join(".reposkein");
            std::fs::create_dir_all(&out_dir).context("failed to create .reposkein/")?;
            let nodes_path = out_dir.join("nodes.jsonl");
            let nodes = if nodes_path.exists() {
                let prev =
                    std::fs::read_to_string(&nodes_path).context("read existing nodes.jsonl")?;
                let existing = reposkein_core::jsonl::read_nodes(&prev)?;
                reposkein_core::merge::graft_summaries(&graph.nodes, &existing)
            } else {
                graph.nodes.clone()
            };
            std::fs::write(&nodes_path, jsonl::nodes_to_jsonl(&nodes))
                .context("failed to write nodes.jsonl")?;
            std::fs::write(
                out_dir.join("edges.jsonl"),
                jsonl::edges_to_jsonl(&graph.edges),
            )
            .context("failed to write edges.jsonl")?;

            println!(
                "indexed repo_id={repo} name={repo_name}: {} nodes, {} edges",
                graph.nodes.len(),
                graph.edges.len()
            );
            Ok(())
        }
        Commands::Load { path, repo_id } => {
            let repo = repo_id.unwrap_or_else(|| compute_repo_id(&path));
            let dir = path.join(".reposkein");
            let nodes_txt =
                std::fs::read_to_string(dir.join("nodes.jsonl")).context("read nodes.jsonl")?;
            let edges_txt =
                std::fs::read_to_string(dir.join("edges.jsonl")).context("read edges.jsonl")?;
            let graph = reposkein_core::Graph {
                nodes: reposkein_core::jsonl::read_nodes(&nodes_txt)?,
                edges: reposkein_core::jsonl::read_edges(&edges_txt)?,
            };
            let store = reposkein_neo4j_io::Neo4jStore::from_env()?;
            store.import_graph(&repo, &graph)?;
            println!(
                "loaded repo_id={repo}: {} nodes, {} edges into Neo4j",
                graph.nodes.len(),
                graph.edges.len()
            );
            Ok(())
        }
        Commands::Export {
            path,
            repo_id,
            full: _,
        } => {
            let repo = repo_id.unwrap_or_else(|| compute_repo_id(&path));
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
        Commands::Purge { repo } => {
            let store = reposkein_neo4j_io::Neo4jStore::from_env()?;
            let n = store.purge(&repo)?;
            println!("purged {n} nodes for repo_id={repo}");
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
