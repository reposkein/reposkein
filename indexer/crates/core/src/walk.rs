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
    for result in WalkBuilder::new(root).build() {
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
}
