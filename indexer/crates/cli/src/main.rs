//! reposkein-indexer CLI. M0: the `index` subcommand walks a repository and
//! writes canonical `.reposkein/nodes.jsonl` + `.reposkein/edges.jsonl`.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use reposkein_core::{index_tree, jsonl};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Parser)]
#[command(name = "reposkein-indexer", version, about = "RepoSkein native indexer")]
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
}

fn run_git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").arg("-C").arg(root).args(args).output().ok()?;
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
        Commands::Index { path, repo_id, name } => {
            let repo = repo_id.unwrap_or_else(|| compute_repo_id(&path));
            let repo_name = name.unwrap_or_else(|| {
                path.canonicalize()
                    .ok()
                    .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                    .unwrap_or_else(|| "repo".to_string())
            });

            let graph = index_tree(&path, &repo, &repo_name)
                .context("failed to index repository tree")?;

            let out_dir = path.join(".reposkein");
            std::fs::create_dir_all(&out_dir).context("failed to create .reposkein/")?;
            std::fs::write(out_dir.join("nodes.jsonl"), jsonl::nodes_to_jsonl(&graph.nodes))
                .context("failed to write nodes.jsonl")?;
            std::fs::write(out_dir.join("edges.jsonl"), jsonl::edges_to_jsonl(&graph.edges))
                .context("failed to write edges.jsonl")?;

            println!(
                "indexed repo_id={repo} name={repo_name}: {} nodes, {} edges",
                graph.nodes.len(),
                graph.edges.len()
            );
            Ok(())
        }
    }
}
