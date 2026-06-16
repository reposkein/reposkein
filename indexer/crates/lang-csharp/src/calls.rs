//! C# call-site extraction.

use reposkein_core::extractor::{RawCall, RawConstruction};
use reposkein_lang_common::{text, CallConfig};
use tree_sitter::Node as TsNode;

#[allow(clippy::too_many_arguments)]
pub fn collect_calls(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_qualified: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<RawCall>,
    out_constructions: &mut Vec<RawConstruction>,
) {
    let cfg = CallConfig {
        boundaries: &[
            "method_declaration",
            "constructor_declaration",
            "local_function_statement",
            "lambda_expression",
            "anonymous_method_expression",
        ],
        call_kind: "invocation_expression",
        classify: classify_call,
    };
    reposkein_lang_common::collect_calls(
        node,
        source,
        caller_id,
        caller_qualified,
        caller_path,
        out,
        &cfg,
    );
    collect_constructions(
        node,
        source,
        caller_id,
        caller_path,
        caller_file_id,
        out_constructions,
        cfg.boundaries,
    );
}

fn collect_constructions(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<RawConstruction>,
    boundaries: &[&str],
) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if boundaries.contains(&child.kind()) {
            continue;
        }
        if child.kind() == "object_creation_expression" {
            // C# `new Foo(...)` or `new Foo { ... }`
            if let Some(ty_node) = child.child_by_field_name("type") {
                let type_name = match ty_node.kind() {
                    "identifier" => text(ty_node, source).to_string(),
                    "generic_name" => {
                        // e.g. `new List<int>()` → "List"
                        ty_node
                            .child_by_field_name("name")
                            .map(|n| text(n, source).to_string())
                            .unwrap_or_else(|| text(ty_node, source).to_string())
                    }
                    "qualified_name" => {
                        // e.g. `new System.Text.StringBuilder()` → "StringBuilder"
                        let mut c = ty_node.walk();
                        ty_node
                            .named_children(&mut c)
                            .filter(|n| n.kind() == "identifier")
                            .last()
                            .map(|n| text(n, source).to_string())
                            .unwrap_or_default()
                    }
                    _ => text(ty_node, source).to_string(),
                };
                if !type_name.is_empty() {
                    out.push(RawConstruction {
                        caller_id: caller_id.to_string(),
                        caller_path: caller_path.to_string(),
                        caller_file_id: caller_file_id.to_string(),
                        class_name: type_name,
                    });
                }
            }
            // implicit new() has no type — skip
        }
        collect_constructions(
            child,
            source,
            caller_id,
            caller_path,
            caller_file_id,
            out,
            boundaries,
        );
    }
}

fn classify_call(func: TsNode, source: &[u8]) -> (String, Option<String>) {
    match func.kind() {
        "identifier" => (text(func, source).to_string(), None),
        "member_access_expression" => {
            let name = func
                .child_by_field_name("name")
                .map(|n| text(n, source).to_string())
                .unwrap_or_default();
            let receiver = func
                .child_by_field_name("expression")
                .map(|n| text(n, source).to_string());
            (name, receiver)
        }
        _ => (String::new(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    /// Find the first node of the given kind anywhere in the subtree.
    fn find_first<'a>(node: tree_sitter::Node<'a>, kind: &str) -> Option<tree_sitter::Node<'a>> {
        if node.kind() == kind {
            return Some(node);
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if let Some(found) = find_first(child, kind) {
                return Some(found);
            }
        }
        None
    }

    #[test]
    fn collects_bare_and_member_calls() {
        let src = b"class C { void Run() { Foo(); obj.Bar(); this.X(); Type.StaticM(); } }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let method =
            find_first(root, "method_declaration").expect("should find method_declaration");
        let body = method
            .child_by_field_name("body")
            .expect("method should have body field");
        let mut calls = Vec::new();
        collect_calls(
            body,
            src,
            "cid",
            "C.Run",
            "C.cs",
            "rs1:r:file:C.cs",
            &mut calls,
            &mut Vec::new(),
        );
        let pairs: Vec<(&str, Option<&str>)> = calls
            .iter()
            .map(|c| (c.callee_name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(pairs.contains(&("Foo", None)), "bare call Foo()");
        assert!(pairs.contains(&("Bar", Some("obj"))), "obj.Bar() call");
        assert!(pairs.contains(&("X", Some("this"))), "this.X() call");
        assert!(
            pairs.contains(&("StaticM", Some("Type"))),
            "Type.StaticM() call"
        );
    }

    #[test]
    fn does_not_descend_into_nested_scope() {
        // Calls inside a lambda should not be attributed to the outer method.
        let src = b"class C { void Run() { Action a = () => { inner(); }; } }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let method =
            find_first(root, "method_declaration").expect("should find method_declaration");
        let body = method
            .child_by_field_name("body")
            .expect("method should have body field");
        let mut calls = Vec::new();
        collect_calls(
            body,
            src,
            "cid",
            "C.Run",
            "C.cs",
            "rs1:r:file:C.cs",
            &mut calls,
            &mut Vec::new(),
        );
        assert!(
            !calls.iter().any(|c| c.callee_name == "inner"),
            "calls inside lambda_expression must not attribute to outer Run"
        );
    }
}
