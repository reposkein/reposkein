//! C# call-site extraction.

use reposkein_core::extractor::RawCall;
use reposkein_lang_common::{text, CallConfig};
use tree_sitter::Node as TsNode;

pub fn collect_calls(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_qualified: &str,
    caller_path: &str,
    out: &mut Vec<RawCall>,
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
        collect_calls(body, src, "cid", "C.Run", "C.cs", &mut calls);
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
        collect_calls(body, src, "cid", "C.Run", "C.cs", &mut calls);
        assert!(
            !calls.iter().any(|c| c.callee_name == "inner"),
            "calls inside lambda_expression must not attribute to outer Run"
        );
    }
}
