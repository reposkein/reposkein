//! Git-aware repository walk. Respects .gitignore and skips hidden entries
//! (including .git) via the `ignore` crate defaults. Output is sorted by
//! repo-relative, forward-slash path for determinism.

use anyhow::Result;
use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// Repo-relative path, forward slashes, never starts with "./".
    pub rel_path: String,
    pub is_dir: bool,
    pub abs_path: PathBuf,
}

pub fn walk(root: &Path) -> Result<Vec<Entry>> {
    let mut out: Vec<Entry> = Vec::new();
    for result in WalkBuilder::new(root)
        .hidden(true)        // skip dotfiles/dotdirs (incl. .git)
        .git_ignore(true)    // honor in-repo .gitignore
        .git_global(false)   // ignore the user's global gitignore
        .git_exclude(false)  // ignore .git/info/exclude
        .parents(false)      // ignore .gitignore in parent dirs above root
        .ignore(false)       // ignore ripgrep .ignore files
        .require_git(false)  // apply .gitignore rules even when root isn't a git repo
        .build()
    {
        let dent = result?;
        let path = dent.path();
        if path == root {
            continue;
        }
        let rel = path
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/");
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(Entry {
            rel_path: rel,
            is_dir,
            abs_path: path.to_path_buf(),
        });
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

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

        let paths: Vec<String> =
            walk(root).unwrap().into_iter().map(|e| e.rel_path).collect();
        assert!(paths.contains(&"keep.py".to_string()), ".ignore must not exclude keep.py");
        assert!(!paths.contains(&"dropped.py".to_string()), ".gitignore must still exclude dropped.py");
    }
}
