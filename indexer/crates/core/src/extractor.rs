//! Language-extractor interface. `core` defines it; per-language crates
//! implement it; the CLI injects implementations into `index_tree`. The
//! dependency arrow is always (lang-* → core), never the reverse.

use crate::model::{Edge, Node};
use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawImport {
    pub importing_file_id: String,
    pub importing_path: String,
    /// Imported symbols as (local_binding, original_name); equal when not aliased.
    pub symbols: Vec<(String, String)>,
    pub candidate_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reexport: bool, // true for Rust `pub use` re-exports
}

/// A call site before resolution. `caller_id` is the enclosing Function node id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawCall {
    pub caller_id: String,
    pub caller_path: String,
    /// qualified_name of the enclosing function (for self/cls method resolution).
    pub caller_qualified: String,
    pub callee_name: String,
    /// `Some(obj)` for `obj.callee()`; `None` for a bare `callee()`.
    pub receiver: Option<String>,
}

/// A heritage relationship (INHERITS/IMPLEMENTS) before cross-file resolution.
/// The deriving (`from`) side is already resolved to a frozen node id by the
/// language walk; only `base_name` needs repo-wide resolution by `core::resolve`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawHeritage {
    /// Stable id of the deriving type node (Class/Interface/Enum), already frozen.
    pub from_id: String,
    /// The deriving file's repo-relative path (same-dir rung + import lookup).
    pub from_path: String,
    /// The deriving file's File-node id (it is the importer of its base).
    pub from_file_id: String,
    /// edge_type as the language determined it (provisional when `label_refine`).
    pub edge_type: String,
    /// The base type's simple (last-segment) name, generics stripped.
    pub base_name: String,
    /// True only for C# `base_list`: the resolver may override `edge_type` from
    /// the resolved target's label. False when syntax is authoritative.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub label_refine: bool,
}

/// Nodes and edges contributed by an extractor for a single file.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtractOutput {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub imports: Vec<RawImport>,
    pub calls: Vec<RawCall>,
    #[serde(default)]
    pub heritage: Vec<RawHeritage>,
}

pub trait Extractor {
    /// The `language` label (matching `classify::language_for`) this handles.
    fn language(&self) -> &'static str;
    /// Extract definitions for one file. Must be deterministic.
    fn extract(&self, ctx: &FileContext) -> ExtractOutput;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Edge, Node};
    use serde_json::json;

    #[test]
    fn extract_output_serde_round_trips() {
        let mut out = ExtractOutput::default();
        out.nodes.push(
            Node::new("rs1:r:func:a.py#f@1", "Function")
                .set("qualified_name", json!("f"))
                .set("start_line", json!(3))
                .set("confidence", json!(0.7)),
        );
        out.edges.push(Edge::new(
            "rs1:r:func:a.py#f@1",
            "DEFINES",
            "rs1:r:func:a.py#g@0",
        ));
        out.imports.push(RawImport {
            importing_file_id: "rs1:r:file:a.py".into(),
            importing_path: "a.py".into(),
            symbols: vec![("g".into(), "g".into())],
            candidate_paths: vec!["b.py".into()],
            reexport: false,
        });
        out.calls.push(RawCall {
            caller_id: "rs1:r:func:a.py#f@1".into(),
            caller_path: "a.py".into(),
            caller_qualified: "f".into(),
            callee_name: "g".into(),
            receiver: None,
        });
        out.heritage.push(RawHeritage {
            from_id: "rs1:r:class:a.py#B".into(),
            from_path: "a.py".into(),
            from_file_id: "rs1:r:file:a.py".into(),
            edge_type: "INHERITS".into(),
            base_name: "A".into(),
            label_refine: false,
        });

        let text = serde_json::to_string(&out).unwrap();
        let back: ExtractOutput = serde_json::from_str(&text).unwrap();
        assert_eq!(back, out, "ExtractOutput must round-trip losslessly");
    }
}
