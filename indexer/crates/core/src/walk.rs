//! Git-aware repository walk. Respects .gitignore and skips hidden entries
//! (including .git) via the `ignore` crate defaults. Output is sorted by
//! repo-relative, forward-slash path for determinism.

use anyhow::Result;
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// Repo-relative path, forward slashes, never starts with "./".
    pub rel_path: String,
    pub is_dir: bool,
    pub abs_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BoundaryKind {
    ReposkeinChild,
    GitOnly,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Boundary {
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub kind: BoundaryKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WalkOutput {
    pub entries: Vec<Entry>,
    pub boundaries: Vec<Boundary>,
}

/// Classifies a directory as a repo boundary: a committed RepoSkein child
/// (`.reposkein/meta.json`) or a bare nested git repo (`.git`, dir or file).
fn boundary_kind(dir: &Path) -> Option<BoundaryKind> {
    if dir.join(".reposkein").join("meta.json").is_file() {
        return Some(BoundaryKind::ReposkeinChild);
    }
    if dir.join(".git").exists() {
        return Some(BoundaryKind::GitOnly);
    }
    None
}

/// Git-aware walk that, when `federation` is true, prunes nested repos and
/// reports them as boundaries (depth >= 1 only — the root's own `.reposkein/`
/// never makes the root a boundary). `walk()` is `walk_federated(root, false)`.
pub fn walk_federated(root: &Path, federation: bool) -> Result<WalkOutput> {
    let found: Arc<Mutex<Vec<Boundary>>> = Arc::new(Mutex::new(Vec::new()));

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .ignore(false)
        .require_git(false);
    if federation {
        let root_owned = root.to_path_buf();
        let found_cl = Arc::clone(&found);
        builder.filter_entry(move |dent| {
            // Prune (return false) a boundary directory at depth >= 1.
            if dent.depth() >= 1 && dent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(kind) = boundary_kind(dent.path()) {
                    if let Ok(rel) = dent.path().strip_prefix(&root_owned) {
                        found_cl.lock().unwrap().push(Boundary {
                            rel_path: rel.to_string_lossy().replace('\\', "/"),
                            abs_path: dent.path().to_path_buf(),
                            kind,
                        });
                    }
                    return false; // prune the subtree
                }
            }
            true
        });
    }

    let mut entries: Vec<Entry> = Vec::new();
    {
        // Build and immediately consume the walker inside a block so that both
        // `builder` (which holds the filter closure and therefore a clone of
        // `found`) and the walker are dropped before we call `Arc::try_unwrap`.
        let walker = builder.build();
        // Drop builder now so its copy of the closure (and the Arc clone) is gone.
        // The walker itself does not hold the filter closure on `build()` in the
        // ignore crate's single-threaded `Walk`.
        for result in walker {
            let dent = result?;
            let path = dent.path();
            if path == root {
                continue;
            }
            // Skip non-UTF-8 paths: a lossy conversion could collide with
            // another path and be silently deduped (PRD §6.2 determinism).
            let Some(rel_raw) = path.strip_prefix(root)?.to_str() else {
                continue;
            };
            let rel = rel_raw.replace('\\', "/");
            let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push(Entry {
                rel_path: rel,
                is_dir,
                abs_path: path.to_path_buf(),
            });
        }
    }

    // Re-synthesize a Directory entry for each pruned boundary (no tree hole).
    // Use lock() since we cannot guarantee sole Arc ownership (builder may still
    // hold a clone of the closure internally via the ignore crate internals).
    let mut boundaries: Vec<Boundary> = found.lock().unwrap().drain(..).collect();
    boundaries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    boundaries.dedup_by(|a, b| a.rel_path == b.rel_path);
    for b in &boundaries {
        entries.push(Entry {
            rel_path: b.rel_path.clone(),
            is_dir: true,
            abs_path: b.abs_path.clone(),
        });
    }
    entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    entries.dedup_by(|a, b| a.rel_path == b.rel_path);

    Ok(WalkOutput {
        entries,
        boundaries,
    })
}

pub fn walk(root: &Path) -> Result<Vec<Entry>> {
    Ok(walk_federated(root, false)?.entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn federated_walk_prunes_child_repos_and_records_boundaries() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("top.py"), b"t").unwrap();
        // A nested RepoSkein child: has .reposkein/meta.json.
        fs::create_dir_all(root.join("vendor/childA/.reposkein")).unwrap();
        fs::write(
            root.join("vendor/childA/.reposkein/meta.json"),
            b"{\"repo_id\":\"childa\"}",
        )
        .unwrap();
        fs::write(root.join("vendor/childA/inner.py"), b"i").unwrap(); // must NOT be walked
                                                                       // A git-only nested repo: has .git, no .reposkein.
        fs::create_dir_all(root.join("vendor/childB/.git")).unwrap();
        fs::write(root.join("vendor/childB/x.py"), b"x").unwrap(); // must NOT be walked

        let out = walk_federated(root, true).unwrap();
        let paths: Vec<&str> = out.entries.iter().map(|e| e.rel_path.as_str()).collect();
        // Root files + the vendor dirs (as boundary Directory entries), but NOT child contents.
        assert!(paths.contains(&"top.py"));
        assert!(paths.contains(&"vendor/childA")); // synthesized boundary dir entry
        assert!(paths.contains(&"vendor/childB"));
        assert!(
            !paths.iter().any(|p| p.contains("inner.py")),
            "child source must be pruned"
        );
        assert!(
            !paths.iter().any(|p| p.contains("childB/x.py")),
            "git-only child pruned"
        );

        let kinds: Vec<(&str, &BoundaryKind)> = out
            .boundaries
            .iter()
            .map(|b| (b.rel_path.as_str(), &b.kind))
            .collect();
        assert!(kinds.contains(&("vendor/childA", &BoundaryKind::ReposkeinChild)));
        assert!(kinds.contains(&("vendor/childB", &BoundaryKind::GitOnly)));
    }

    #[test]
    fn non_federated_walk_descends_into_children() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("vendor/childA/.reposkein")).unwrap();
        fs::write(
            root.join("vendor/childA/.reposkein/meta.json"),
            b"{\"repo_id\":\"childa\"}",
        )
        .unwrap();
        fs::write(root.join("vendor/childA/inner.py"), b"i").unwrap();
        let out = walk_federated(root, false).unwrap();
        assert!(
            out.entries
                .iter()
                .any(|e| e.rel_path == "vendor/childA/inner.py"),
            "old behavior: descend"
        );
        assert!(out.boundaries.is_empty());
    }

    #[test]
    fn walks_sorted_and_respects_gitignore_and_hidden() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.py"), b"a").unwrap();
        fs::write(root.join("b.py"), b"b").unwrap();
        fs::write(root.join(".gitignore"), b"ignored.py\n").unwrap();
        fs::write(root.join("ignored.py"), b"x").unwrap();
        // Hidden dir should be skipped by default.
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), b"ref").unwrap();

        let entries = walk(root).unwrap();
        let paths: Vec<&str> = entries.iter().map(|e| e.rel_path.as_str()).collect();

        // .gitignore itself is hidden → skipped; ignored.py → gitignored;
        // .git → hidden. Remaining, sorted:
        assert_eq!(paths, vec!["b.py", "src", "src/a.py"]);
        let src = entries.iter().find(|e| e.rel_path == "src").unwrap();
        assert!(src.is_dir);
    }

    #[test]
    fn ignores_only_in_repo_gitignore_not_dot_ignore() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("keep.py"), b"k").unwrap();
        // A ripgrep-style `.ignore` file must NOT affect the walk (machine/tool
        // state, not committed repo state).
        fs::write(root.join(".ignore"), b"keep.py\n").unwrap();
        // An in-repo .gitignore MUST still exclude.
        fs::write(root.join(".gitignore"), b"dropped.py\n").unwrap();
        fs::write(root.join("dropped.py"), b"d").unwrap();

        let paths: Vec<String> = walk(root)
            .unwrap()
            .into_iter()
            .map(|e| e.rel_path)
            .collect();
        assert!(
            paths.contains(&"keep.py".to_string()),
            ".ignore must not exclude keep.py"
        );
        assert!(
            !paths.contains(&"dropped.py".to_string()),
            ".gitignore must still exclude dropped.py"
        );
    }
}
