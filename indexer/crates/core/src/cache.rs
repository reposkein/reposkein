//! Per-file ExtractOutput cache (PRD §3.8, Bet 2). Keyed by
//! (repo_id, rel_path, content_hash, schema); a cache hit skips Tree-sitter
//! parsing for an unchanged file. The cache is an optimization only — it never
//! affects committed output (the canonical serializer stays the sole producer
//! of bytes), so all operations are best-effort: read/parse failures are a
//! miss, write failures are ignored.

use crate::extractor::ExtractOutput;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Bump to invalidate every cache entry (e.g. when extractor logic changes
/// the ExtractOutput for unchanged source).
pub const EXTRACT_CACHE_SCHEMA: u32 = 3;

/// A cache of per-file extraction results.
pub trait ExtractCache {
    /// Returns the cached output iff a record exists whose schema/repo_id/
    /// rel_path/content_hash all match.
    fn get(&self, repo_id: &str, rel_path: &str, content_hash: &str) -> Option<ExtractOutput>;
    /// Stores (overwrites) the output for this file. Best-effort.
    fn put(&self, repo_id: &str, rel_path: &str, content_hash: &str, output: &ExtractOutput);
}

#[derive(Serialize, Deserialize)]
struct CacheRecord {
    schema: u32,
    repo_id: String,
    rel_path: String,
    content_hash: String,
    output: ExtractOutput,
}

/// Filesystem cache: one JSON record per source file under `root`, named by the
/// BLAKE3 hex of the rel_path.
pub struct FsExtractCache {
    root: PathBuf,
}

impl FsExtractCache {
    /// Opens (and creates) a cache rooted at `root`. Returns None if the
    /// directory cannot be created (caller proceeds without a cache).
    pub fn open(root: impl Into<PathBuf>) -> Option<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root).ok()?;
        Some(FsExtractCache { root })
    }

    fn entry_path(&self, rel_path: &str) -> PathBuf {
        let name = blake3::hash(rel_path.as_bytes()).to_hex().to_string();
        self.root.join(format!("{name}.json"))
    }

    /// Removes the cache entry for a file, forcing a fresh extract on the next
    /// index even if its content_hash is unchanged. Best-effort.
    pub fn invalidate(&self, rel_path: &str) {
        let _ = std::fs::remove_file(self.entry_path(rel_path));
    }
}

impl ExtractCache for FsExtractCache {
    fn get(&self, repo_id: &str, rel_path: &str, content_hash: &str) -> Option<ExtractOutput> {
        let text = std::fs::read_to_string(self.entry_path(rel_path)).ok()?;
        let rec: CacheRecord = serde_json::from_str(&text).ok()?;
        if rec.schema == EXTRACT_CACHE_SCHEMA
            && rec.repo_id == repo_id
            && rec.rel_path == rel_path
            && rec.content_hash == content_hash
        {
            Some(rec.output)
        } else {
            None
        }
    }

    fn put(&self, repo_id: &str, rel_path: &str, content_hash: &str, output: &ExtractOutput) {
        let rec = CacheRecord {
            schema: EXTRACT_CACHE_SCHEMA,
            repo_id: repo_id.to_string(),
            rel_path: rel_path.to_string(),
            content_hash: content_hash.to_string(),
            output: output.clone(),
        };
        if let Ok(text) = serde_json::to_string(&rec) {
            let _ = write_atomic(&self.entry_path(rel_path), &text);
        }
    }
}

/// Writes via a temp file + rename so a concurrent reader never sees a partial
/// record. Best-effort; errors propagate to the caller which ignores them.
fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Node;
    use serde_json::json;
    use tempfile::tempdir;

    fn sample() -> ExtractOutput {
        let mut o = ExtractOutput::default();
        o.nodes
            .push(Node::new("rs1:r:func:a.py#f@0", "Function").set("start_line", json!(1)));
        o
    }

    #[test]
    fn miss_on_empty_cache() {
        let dir = tempdir().unwrap();
        let cache = FsExtractCache::open(dir.path()).unwrap();
        assert!(cache.get("r", "a.py", "h1").is_none());
    }

    #[test]
    fn hit_after_put_with_matching_key() {
        let dir = tempdir().unwrap();
        let cache = FsExtractCache::open(dir.path()).unwrap();
        let out = sample();
        cache.put("r", "a.py", "h1", &out);
        assert_eq!(cache.get("r", "a.py", "h1"), Some(out));
    }

    #[test]
    fn miss_when_content_hash_differs() {
        let dir = tempdir().unwrap();
        let cache = FsExtractCache::open(dir.path()).unwrap();
        cache.put("r", "a.py", "h1", &sample());
        assert!(
            cache.get("r", "a.py", "h2").is_none(),
            "edited file must miss"
        );
    }

    #[test]
    fn miss_when_repo_differs() {
        let dir = tempdir().unwrap();
        let cache = FsExtractCache::open(dir.path()).unwrap();
        cache.put("r", "a.py", "h1", &sample());
        assert!(cache.get("other", "a.py", "h1").is_none());
    }

    #[test]
    fn put_overwrites_same_file_on_edit() {
        let dir = tempdir().unwrap();
        let cache = FsExtractCache::open(dir.path()).unwrap();
        cache.put("r", "a.py", "h1", &sample());
        let mut edited = sample();
        edited.nodes[0] = Node::new("rs1:r:func:a.py#f@0", "Function").set("start_line", json!(9));
        cache.put("r", "a.py", "h2", &edited);
        assert!(cache.get("r", "a.py", "h1").is_none());
        assert_eq!(cache.get("r", "a.py", "h2"), Some(edited));
    }

    #[test]
    fn invalidate_forces_a_miss() {
        let dir = tempdir().unwrap();
        let cache = FsExtractCache::open(dir.path()).unwrap();
        cache.put("r", "a.py", "h1", &sample());
        assert!(cache.get("r", "a.py", "h1").is_some());
        cache.invalidate("a.py");
        assert!(
            cache.get("r", "a.py", "h1").is_none(),
            "invalidated entry must miss"
        );
    }
}
