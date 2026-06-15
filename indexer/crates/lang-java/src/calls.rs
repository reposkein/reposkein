//! Java call-site collection: method_invocation → RawCall.
//! Does not use lang-common::collect_calls (which assumes a `function` field).
//! Java's method_invocation uses `object` (optional) and `name` fields instead.

use reposkein_core::extractor::RawCall;
use reposkein_lang_common::text;
use tree_sitter::Node as TsNode;

const BOUNDARIES: &[&str] = &[
    "method_declaration",
    "constructor_declaration",
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "lambda_expression",
    "static_initializer",
];

pub fn collect_calls(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_qualified: &str,
    caller_path: &str,
    out: &mut Vec<RawCall>,
) {
    walk(node, source, caller_id, caller_qualified, caller_path, out);
}

fn walk(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_qualified: &str,
    caller_path: &str,
    out: &mut Vec<RawCall>,
) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if BOUNDARIES.contains(&child.kind()) {
            continue; // do not descend into nested scopes
        }
        if child.kind() == "method_invocation" {
            if let Some(name_node) = child.child_by_field_name("name") {
                let callee_name = text(name_node, source).to_string();
                if !callee_name.is_empty() {
                    let receiver = child
                        .child_by_field_name("object")
                        .map(|n| text(n, source).to_string());
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
        // Recurse into non-boundary children
        walk(child, source, caller_id, caller_qualified, caller_path, out);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn find_method_body<'a>(node: TsNode<'a>) -> Option<TsNode<'a>> {
        if node.kind() == "method_declaration" {
            return node.child_by_field_name("body");
        }
        let mut c = node.walk();
        for child in node.named_children(&mut c) {
            if let Some(b) = find_method_body(child) {
                return Some(b);
            }
        }
        None
    }

    #[test]
    fn collects_bare_and_obj_and_this_calls() {
        let src =
            b"package p;\nclass C {\n void run() {\n foo();\n obj.bar();\n this.baz();\n }\n}\n";
        let tree = parse(src).unwrap();
        let body = find_method_body(tree.root_node()).unwrap();
        let mut calls = Vec::new();
        collect_calls(body, src, "cid", "C.run", "p/C.java", &mut calls);
        let pairs: Vec<(&str, Option<&str>)> = calls
            .iter()
            .map(|c| (c.callee_name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(pairs.contains(&("foo", None)));
        assert!(pairs.contains(&("bar", Some("obj"))));
        assert!(pairs.contains(&("baz", Some("this"))));
    }

    #[test]
    fn does_not_descend_into_lambda() {
        let src = b"package p;\nclass C {\n void run() {\n Runnable r = () -> inner();\n }\n}\n";
        let tree = parse(src).unwrap();
        let body = find_method_body(tree.root_node()).unwrap();
        let mut calls = Vec::new();
        collect_calls(body, src, "cid", "C.run", "p/C.java", &mut calls);
        assert!(
            !calls.iter().any(|c| c.callee_name == "inner"),
            "calls inside lambda must not attribute to outer method"
        );
    }
}
