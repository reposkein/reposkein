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

/// Nodes and edges contributed by an extractor for a single file.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ExtractOutput {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

pub trait Extractor {
    /// The `language` label (matching `classify::language_for`) this handles.
    fn language(&self) -> &'static str;
    /// Extract definitions for one file. Must be deterministic.
    fn extract(&self, ctx: &FileContext) -> ExtractOutput;
}
