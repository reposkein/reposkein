//! Collect call sites inside one function body → RawCall, attributing to the
//! nearest enclosing function. Does not descend into nested func literals
//! (closures) — they are collected when the outer walk reaches them.

use reposkein_core::extractor::RawCall;
use reposkein_lang_common::{text, CallConfig};
use tree_sitter::Node as TsNode;

const CONFIG: CallConfig = CallConfig {
    boundaries: &["function_declaration", "method_declaration", "func_literal"],
    call_kind: "call_expression",
    classify,
};

fn classify(func: TsNode, source: &[u8]) -> (String, Option<String>) {
    match func.kind() {
        "identifier" => (text(func, source).to_string(), None),
        "selector_expression" => {
            let name = func
                .child_by_field_name("field")
                .map(|n| text(n, source).to_string())
                .unwrap_or_default();
            let recv = func
                .child_by_field_name("operand")
                .map(|n| text(n, source).to_string());
            (name, recv)
        }
        _ => (String::new(), None), // type conversions, make/new, etc.
    }
}

pub fn collect_calls(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_qualified: &str,
    caller_path: &str,
    out: &mut Vec<RawCall>,
) {
    reposkein_lang_common::collect_calls(
        node,
        source,
        caller_id,
        caller_qualified,
        caller_path,
        out,
        &CONFIG,
    );
}

pub fn collect_constructions(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<reposkein_core::extractor::RawConstruction>,
) {
    // Boundaries: do not descend into nested func literals (their constructions
    // will be attributed when the outer walk reaches them as their own function scope).
    const BOUNDARIES: &[&str] = &["function_declaration", "method_declaration", "func_literal"];
    collect_constructions_inner(
        node,
        source,
        caller_id,
        caller_path,
        caller_file_id,
        out,
        BOUNDARIES,
    );
}

fn collect_constructions_inner(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<reposkein_core::extractor::RawConstruction>,
    boundaries: &[&str],
) {
    let kind = node.kind();

    // Direct composite_literal: `Foo{}` or `pkg.Foo{}`
    if kind == "composite_literal" {
        if let Some(class_name) = composite_literal_class_name(node, source) {
            out.push(reposkein_core::extractor::RawConstruction {
                caller_id: caller_id.to_string(),
                caller_path: caller_path.to_string(),
                caller_file_id: caller_file_id.to_string(),
                class_name,
            });
        }
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if boundaries.contains(&child.kind()) {
            continue;
        }
        collect_constructions_inner(
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

/// Returns the class name for a `composite_literal` node, or None if the type
/// is anonymous (slice, map, array, struct-type, etc.).
fn composite_literal_class_name(node: TsNode, source: &[u8]) -> Option<String> {
    let ty = node.child_by_field_name("type")?;
    match ty.kind() {
        "type_identifier" => {
            let name = text(ty, source).to_string();
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        }
        "qualified_type" => {
            // `pkg.Foo{}` → name field is the last segment "Foo"
            ty.child_by_field_name("name")
                .map(|n| text(n, source).to_string())
                .filter(|s| !s.is_empty())
        }
        // Anonymous types: skip
        "slice_type" | "map_type" | "array_type" | "struct_type" | "pointer_type" => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;
    use reposkein_core::extractor::RawConstruction;

    #[test]
    fn bare_composite_literal_emits_construction() {
        // `Foo{}` → RawConstruction{class_name:"Foo"}
        let src = b"package p\nfunc caller() { _ = Foo{} }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_declaration")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut constructions: Vec<RawConstruction> = Vec::new();
        collect_constructions(body, src, "cid", "pkg/m.go", "fid", &mut constructions);
        assert_eq!(constructions.len(), 1, "Foo{{}} must emit 1 RawConstruction");
        assert_eq!(constructions[0].class_name, "Foo");
    }

    #[test]
    fn ref_composite_literal_emits_construction() {
        // `&Foo{}` → RawConstruction{class_name:"Foo"}
        let src = b"package p\nfunc caller() { _ = &Foo{} }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_declaration")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut constructions: Vec<RawConstruction> = Vec::new();
        collect_constructions(body, src, "cid", "pkg/m.go", "fid", &mut constructions);
        assert_eq!(
            constructions.len(),
            1,
            "&Foo{{}} must emit 1 RawConstruction"
        );
        assert_eq!(constructions[0].class_name, "Foo");
    }

    #[test]
    fn qualified_composite_literal_emits_last_segment() {
        // `pkg.Foo{}` → class_name "Foo"
        let src = b"package p\nfunc caller() { _ = pkg.Foo{} }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_declaration")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut constructions: Vec<RawConstruction> = Vec::new();
        collect_constructions(body, src, "cid", "pkg/m.go", "fid", &mut constructions);
        assert_eq!(
            constructions.len(),
            1,
            "pkg.Foo{{}} must emit 1 RawConstruction"
        );
        assert_eq!(
            constructions[0].class_name, "Foo",
            "qualified: last segment only"
        );
    }

    #[test]
    fn slice_literal_does_not_emit_construction() {
        // `[]int{}` → NO RawConstruction (anonymous type)
        let src = b"package p\nfunc caller() { _ = []int{1, 2} }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_declaration")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut constructions: Vec<RawConstruction> = Vec::new();
        collect_constructions(body, src, "cid", "pkg/m.go", "fid", &mut constructions);
        assert!(
            constructions.is_empty(),
            "[]int{{}} must NOT emit RawConstruction"
        );
    }

    #[test]
    fn map_literal_does_not_emit_construction() {
        // `map[string]int{}` → NO RawConstruction
        let src = b"package p\nfunc caller() { _ = map[string]int{} }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_declaration")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut constructions: Vec<RawConstruction> = Vec::new();
        collect_constructions(body, src, "cid", "pkg/m.go", "fid", &mut constructions);
        assert!(
            constructions.is_empty(),
            "map[string]int{{}} must NOT emit RawConstruction"
        );
    }

    #[test]
    fn go_composite_literal_construction_is_deterministic() {
        let src = b"package p\nfunc caller() { _ = Foo{}; _ = &Bar{} }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_declaration")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut c1: Vec<RawConstruction> = Vec::new();
        let mut c2: Vec<RawConstruction> = Vec::new();
        collect_constructions(body, src, "cid", "pkg/m.go", "fid", &mut c1);
        collect_constructions(body, src, "cid", "pkg/m.go", "fid", &mut c2);
        assert_eq!(c1, c2, "collect_constructions must be deterministic");
    }

    #[test]
    fn collects_bare_and_selector_calls() {
        let src = b"package p\nfunc Run() { helper(); fmt.Println(); obj.Method() }\n";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_declaration")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut calls = Vec::new();
        collect_calls(body, src, "cid", "Run", "pkg/m.go", &mut calls);
        let pairs: Vec<(&str, Option<&str>)> = calls
            .iter()
            .map(|c| (c.callee_name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(pairs.contains(&("helper", None)));
        assert!(pairs.contains(&("Println", Some("fmt"))));
        assert!(pairs.contains(&("Method", Some("obj"))));
    }

    #[test]
    fn does_not_descend_into_func_literal() {
        // Calls inside a func literal should not be attributed to the outer function.
        let src = b"package p\nfunc Run() { go func() { inner() }() }\n";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_declaration")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut calls = Vec::new();
        collect_calls(body, src, "cid", "Run", "pkg/m.go", &mut calls);
        // inner() is inside the func literal — must NOT appear under Run.
        assert!(
            !calls.iter().any(|c| c.callee_name == "inner"),
            "calls inside func_literal must not attribute to outer Run"
        );
    }
}
