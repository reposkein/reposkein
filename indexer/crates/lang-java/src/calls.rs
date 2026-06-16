//! Java call-site collection: method_invocation → RawCall.
//! Does not use lang-common::collect_calls (which assumes a `function` field).
//! Java's method_invocation uses `object` (optional) and `name` fields instead.

use reposkein_core::extractor::{RawCall, RawConstruction};
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
    walk(
        node,
        source,
        caller_id,
        caller_qualified,
        caller_path,
        caller_file_id,
        out,
        out_constructions,
    );
}

fn bound_local_for_java(ctor_node: TsNode<'_>, source: &[u8]) -> Option<String> {
    // object_creation_expression's parent should be variable_declarator
    let declarator = ctor_node.parent()?;
    if declarator.kind() != "variable_declarator" {
        return None;
    }
    // The declarator's parent should be local_variable_declaration
    let decl = declarator.parent()?;
    if decl.kind() != "local_variable_declaration" {
        return None;
    }
    // The declarator's `name` field should be a plain identifier
    let name_node = declarator.child_by_field_name("name")?;
    if name_node.kind() != "identifier" {
        return None;
    }
    Some(text(name_node, source).to_string())
}

#[allow(clippy::too_many_arguments)]
fn walk(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_qualified: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<RawCall>,
    out_constructions: &mut Vec<RawConstruction>,
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
        if child.kind() == "object_creation_expression" {
            // Try the `type` field; if absent, scan named children for a type node.
            let ty_node_opt = child.child_by_field_name("type").or_else(|| {
                let mut c = child.walk();
                let found = child.named_children(&mut c).find(|n| {
                    matches!(
                        n.kind(),
                        "type_identifier" | "generic_type" | "scoped_type_identifier"
                    )
                });
                found
            });
            let type_name: String = if let Some(ty_node) = ty_node_opt {
                match ty_node.kind() {
                    "type_identifier" => text(ty_node, source).to_string(),
                    "generic_type" => {
                        let mut c = ty_node.walk();
                        let found = ty_node
                            .named_children(&mut c)
                            .find(|n| n.kind() == "type_identifier");
                        found
                            .map(|n| text(n, source).to_string())
                            .unwrap_or_default()
                    }
                    "scoped_type_identifier" => {
                        let mut c = ty_node.walk();
                        let last = ty_node
                            .named_children(&mut c)
                            .filter(|n| n.kind() == "type_identifier")
                            .last();
                        last.map(|n| text(n, source).to_string())
                            .unwrap_or_default()
                    }
                    _ => text(ty_node, source).to_string(),
                }
            } else {
                String::new()
            };
            if !type_name.is_empty() {
                let bound_local = bound_local_for_java(child, source);
                out_constructions.push(RawConstruction {
                    caller_id: caller_id.to_string(),
                    caller_path: caller_path.to_string(),
                    caller_file_id: caller_file_id.to_string(),
                    class_name: type_name,
                    bound_local,
                });
            }
        }
        // Recurse into non-boundary children
        walk(
            child,
            source,
            caller_id,
            caller_qualified,
            caller_path,
            caller_file_id,
            out,
            out_constructions,
        );
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
        collect_calls(
            body,
            src,
            "cid",
            "C.run",
            "p/C.java",
            "rs1:r:file:p/C.java",
            &mut calls,
            &mut Vec::new(),
        );
        let pairs: Vec<(&str, Option<&str>)> = calls
            .iter()
            .map(|c| (c.callee_name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(pairs.contains(&("foo", None)));
        assert!(pairs.contains(&("bar", Some("obj"))));
        assert!(pairs.contains(&("baz", Some("this"))));
    }

    #[test]
    fn local_var_decl_has_bound_local() {
        let src = b"class C { void run() { Foo x = new Foo(); } }";
        let tree = parse(src).unwrap();
        let body = find_method_body(tree.root_node()).unwrap();
        let mut constructions = Vec::new();
        collect_calls(
            body,
            src,
            "cid",
            "C.run",
            "C.java",
            "fid",
            &mut Vec::new(),
            &mut constructions,
        );
        assert_eq!(constructions.len(), 1);
        assert_eq!(constructions[0].bound_local, Some("x".to_string()));
    }

    #[test]
    fn return_new_has_no_bound_local() {
        let src = b"class C { Foo run() { return new Foo(); } }";
        let tree = parse(src).unwrap();
        let body = find_method_body(tree.root_node()).unwrap();
        let mut constructions = Vec::new();
        collect_calls(
            body,
            src,
            "cid",
            "C.run",
            "C.java",
            "fid",
            &mut Vec::new(),
            &mut constructions,
        );
        assert_eq!(constructions.len(), 1);
        assert_eq!(constructions[0].bound_local, None);
    }

    #[test]
    fn does_not_descend_into_lambda() {
        let src = b"package p;\nclass C {\n void run() {\n Runnable r = () -> inner();\n }\n}\n";
        let tree = parse(src).unwrap();
        let body = find_method_body(tree.root_node()).unwrap();
        let mut calls = Vec::new();
        collect_calls(
            body,
            src,
            "cid",
            "C.run",
            "p/C.java",
            "rs1:r:file:p/C.java",
            &mut calls,
            &mut Vec::new(),
        );
        assert!(
            !calls.iter().any(|c| c.callee_name == "inner"),
            "calls inside lambda must not attribute to outer method"
        );
    }
}
