//! Tree-sitter helpers shared by the language extractors. Keeps `core`
//! tree-sitter-free: the dependency arrow is lang-* → lang-common → core.

use reposkein_core::extractor::RawCall;
use tree_sitter::Node as TsNode;

/// UTF-8 text of a node (empty string on non-UTF-8 — matches prior behavior).
pub fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

/// Per-language configuration for [`collect_calls`].
pub struct CallConfig {
    /// Node kinds that open a nested scope; the walk does not descend into them
    /// (they are collected when the outer walk reaches them).
    pub boundaries: &'static [&'static str],
    /// The node kind of a call expression in this grammar.
    pub call_kind: &'static str,
    /// Extracts `(callee_name, receiver)` from a call's `function` child.
    /// Returns an empty `callee_name` for forms that aren't a resolvable call.
    pub classify: fn(func: TsNode, source: &[u8]) -> (String, Option<String>),
}

/// Recursively gather call sites under `node`, attributing each to
/// `(caller_id, caller_qualified, caller_path)`. Stops at nested-scope
/// boundaries; descends into call arguments. Behavior is identical across
/// languages — only `cfg` differs.
pub fn collect_calls(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_qualified: &str,
    caller_path: &str,
    out: &mut Vec<RawCall>,
    cfg: &CallConfig,
) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if cfg.boundaries.contains(&child.kind()) {
            continue; // nested scope — collected separately
        }
        if child.kind() == cfg.call_kind {
            if let Some(func) = child.child_by_field_name("function") {
                let (callee_name, receiver) = (cfg.classify)(func, source);
                if !callee_name.is_empty() {
                    out.push(RawCall {
                        caller_id: caller_id.to_string(),
                        caller_path: caller_path.to_string(),
                        caller_qualified: caller_qualified.to_string(),
                        callee_name,
                        receiver,
                    });
                }
            }
        }
        collect_calls(child, source, caller_id, caller_qualified, caller_path, out, cfg);
    }
}
