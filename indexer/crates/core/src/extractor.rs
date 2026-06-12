//! Language-extractor interface. `core` defines it; per-language crates
//! implement it; the CLI injects implementations into `index_tree`. The
//! dependency arrow is always (lang-* → core), never the reverse.

use crate::model::{Edge, Node};

/// Everything an extractor needs about one file. `source` is the raw bytes
/// already read by `index_tree`; `file_id` is the stable id of the File node
/// (so extractors can attach DEFINES edges without recomputing it).
pub struct FileContext<'a> {
    pub repo: &'a str,
    pub rel_path: &'a str,
    pub file_id: &'a str,
    pub source: &'a [u8],
}

/// An import statement before cross-file resolution. `candidate_paths` are
/// repo-relative file paths the importing language deems possible targets
/// (the resolver picks the first that exists as a File node).
#[derive(Debug, Clone, PartialEq)]
pub struct RawImport {
    pub importing_file_id: String,
    pub importing_path: String,
    /// Imported symbols as (local_binding, original_name); equal when not aliased.
    pub symbols: Vec<(String, String)>,
    pub candidate_paths: Vec<String>,
}

/// A call site before resolution. `caller_id` is the enclosing Function node id.
#[derive(Debug, Clone, PartialEq)]
pub struct RawCall {
    pub caller_id: String,
    pub caller_path: String,
    /// qualified_name of the enclosing function (for self/cls method resolution).
    pub caller_qualified: String,
    pub callee_name: String,
    /// `Some(obj)` for `obj.callee()`; `None` for a bare `callee()`.
    pub receiver: Option<String>,
}

/// Nodes and edges contributed by an extractor for a single file.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ExtractOutput {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub imports: Vec<RawImport>,
    pub calls: Vec<RawCall>,
}

pub trait Extractor {
    /// The `language` label (matching `classify::language_for`) this handles.
    fn language(&self) -> &'static str;
    /// Extract definitions for one file. Must be deterministic.
    fn extract(&self, ctx: &FileContext) -> ExtractOutput;
}
