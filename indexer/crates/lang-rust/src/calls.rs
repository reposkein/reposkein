//! Collect call sites inside one function body → RawCall, attributing to the
//! nearest enclosing function (does not descend into nested fns/closures).

use reposkein_core::extractor::RawCall;
use reposkein_lang_common::{text, CallConfig};
use tree_sitter::Node as TsNode;

const CONFIG: CallConfig = CallConfig {
    boundaries: &["function_item", "closure_expression"],
    call_kind: "call_expression",
    classify,
};

fn classify(func: TsNode, source: &[u8]) -> (String, Option<String>) {
    match func.kind() {
        "identifier" => (text(func, source).to_string(), None),
        "field_expression" => {
            let name = func
                .child_by_field_name("field")
                .map(|n| text(n, source).to_string())
                .unwrap_or_default();
            let recv = func
                .child_by_field_name("value")
                .map(|n| text(n, source).to_string());
            (name, recv)
        }
        "scoped_identifier" => {
            let name = func
                .child_by_field_name("name")
                .map(|n| text(n, source).to_string())
                .unwrap_or_default();
            let recv = func
                .child_by_field_name("path")
                .map(|n| text(n, source).to_string());
            (name, recv)
        }
        _ => (String::new(), None),
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

/// Returns the last `type_identifier` text in a path node.
/// Handles: `type_identifier` → itself; `identifier` → itself (path position);
/// `scoped_identifier` / `scoped_type_identifier` → recurse into `name` field.
fn last_type_identifier<'a>(node: tree_sitter::Node<'a>, source: &'a [u8]) -> String {
    match node.kind() {
        "type_identifier" => reposkein_lang_common::text(node, source).to_string(),
        "identifier" => {
            // Plain identifier in path position: treat as the class name.
            reposkein_lang_common::text(node, source).to_string()
        }
        "scoped_identifier" | "scoped_type_identifier" => {
            // The `name` field is the rightmost segment.
            if let Some(name_node) = node.child_by_field_name("name") {
                let s = reposkein_lang_common::text(name_node, source).to_string();
                if !s.is_empty() {
                    return s;
                }
            }
            // Fallback: last named child that is type_identifier or identifier.
            let mut c = node.walk();
            node.named_children(&mut c)
                .filter(|n| n.kind() == "type_identifier" || n.kind() == "identifier")
                .last()
                .map(|n| reposkein_lang_common::text(n, source).to_string())
                .unwrap_or_default()
        }
        _ => String::new(),
    }
}

pub fn collect_constructions(
    node: tree_sitter::Node<'_>,
    source: &[u8],
    caller_id: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<reposkein_core::extractor::RawConstruction>,
) {
    // Don't descend into nested functions/closures.
    const BOUNDARIES: &[&str] = &["function_item", "closure_expression"];
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
    node: tree_sitter::Node<'_>,
    source: &[u8],
    caller_id: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<reposkein_core::extractor::RawConstruction>,
    boundaries: &[&str],
) {
    if node.kind() == "struct_expression" {
        // Rust struct literal: `Foo { field: val }` or `path::Foo { .. }`
        if let Some(name_node) = node.child_by_field_name("name") {
            let class_name = match name_node.kind() {
                "type_identifier" => reposkein_lang_common::text(name_node, source).to_string(),
                "scoped_type_identifier" | "generic_type" => {
                    // Take the last type_identifier segment
                    let mut c = name_node.walk();
                    name_node
                        .named_children(&mut c)
                        .filter(|n| n.kind() == "type_identifier")
                        .last()
                        .map(|n| reposkein_lang_common::text(n, source).to_string())
                        .unwrap_or_default()
                }
                _ => reposkein_lang_common::text(name_node, source).to_string(),
            };
            if !class_name.is_empty() {
                out.push(reposkein_core::extractor::RawConstruction {
                    caller_id: caller_id.to_string(),
                    caller_path: caller_path.to_string(),
                    caller_file_id: caller_file_id.to_string(),
                    class_name,
                });
            }
        }
    }
    // Detect `Foo::new()` associated-function constructors.
    // Conservative: only the `new` segment qualifies (v1).
    if node.kind() == "call_expression" {
        if let Some(func) = node.child_by_field_name("function") {
            if func.kind() == "scoped_identifier" {
                let segment = func
                    .child_by_field_name("name")
                    .map(|n| reposkein_lang_common::text(n, source))
                    .unwrap_or_default();
                if segment == "new" {
                    let class_name = if let Some(path_node) = func.child_by_field_name("path") {
                        last_type_identifier(path_node, source)
                    } else {
                        String::new()
                    };
                    if !class_name.is_empty() {
                        out.push(reposkein_core::extractor::RawConstruction {
                            caller_id: caller_id.to_string(),
                            caller_path: caller_path.to_string(),
                            caller_file_id: caller_file_id.to_string(),
                            class_name,
                        });
                    }
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    #[test]
    fn collects_self_bare_and_scoped_calls() {
        let src =
            b"impl S { fn run(&self) { self.go(); helper(); String::new(); } fn go(&self){} }";
        let tree = parse(src).unwrap();
        let impl_item = tree.root_node().named_child(0).unwrap();
        let body = impl_item.child_by_field_name("body").unwrap();
        let run = body.named_child(0).unwrap();
        let rbody = run.child_by_field_name("body").unwrap();
        let mut calls = Vec::new();
        collect_calls(rbody, src, "cid", "S.run", "m.rs", &mut calls);
        let pairs: Vec<(&str, Option<&str>)> = calls
            .iter()
            .map(|c| (c.callee_name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(pairs.contains(&("go", Some("self"))));
        assert!(pairs.contains(&("helper", None)));
        assert!(pairs.contains(&("new", Some("String"))));
    }

    #[test]
    fn foo_new_emits_raw_construction() {
        // Foo::new() in a function body must emit RawConstruction{class_name:"Foo"}.
        let src =
            b"struct Foo; impl Foo { fn new() -> Foo { Foo } } fn caller() { let x = Foo::new(); }";
        let tree = parse(src).unwrap();
        // caller() is the last top-level function_item
        let root = tree.root_node();
        let caller = root
            .named_children(&mut root.walk())
            .filter(|n| n.kind() == "function_item")
            .last()
            .unwrap();
        let body = caller.child_by_field_name("body").unwrap();
        let mut constructions = Vec::new();
        collect_constructions(
            body,
            src,
            "caller_id",
            "m.rs",
            "file_id",
            &mut constructions,
        );
        assert_eq!(
            constructions.len(),
            1,
            "Foo::new() must emit exactly one RawConstruction"
        );
        assert_eq!(constructions[0].class_name, "Foo");
        assert_eq!(constructions[0].caller_id, "caller_id");
    }

    #[test]
    fn foo_new_does_not_suppress_raw_call() {
        // Foo::new() must ALSO produce a RawCall (CALLS edge to the method); we verify
        // that collect_calls still sees it alongside the RawConstruction.
        let src =
            b"struct Foo; impl Foo { fn new() -> Foo { Foo } } fn caller() { let x = Foo::new(); }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let caller = root
            .named_children(&mut root.walk())
            .filter(|n| n.kind() == "function_item")
            .last()
            .unwrap();
        let body = caller.child_by_field_name("body").unwrap();
        let mut calls = Vec::new();
        collect_calls(body, src, "caller_id", "caller", "m.rs", &mut calls);
        assert!(
            calls.iter().any(|c| c.callee_name == "new"),
            "Foo::new() must still produce a RawCall (callee_name=\"new\")"
        );
    }

    #[test]
    fn scoped_new_with_path_extracts_last_segment() {
        // crate::svc::Foo::new() → class_name "Foo" (last segment of path before ::new)
        let src = b"fn caller() { let _ = crate::svc::Foo::new(); }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_item")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut constructions = Vec::new();
        collect_constructions(body, src, "c", "m.rs", "fid", &mut constructions);
        // Resolver filters externals; here we just check extraction.
        // For `crate::svc::Foo::new()`, the scoped_identifier path is `crate::svc::Foo`
        // (itself a scoped_identifier). The last type_identifier in that path is "Foo".
        assert_eq!(
            constructions.len(),
            1,
            "crate::svc::Foo::new() must emit 1 RawConstruction"
        );
        assert_eq!(constructions[0].class_name, "Foo");
    }

    #[test]
    fn construction_new_is_deterministic() {
        let src = b"struct A; impl A { fn new() -> A { A } } fn run() { let _ = A::new(); }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .filter(|n| n.kind() == "function_item")
            .last()
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut c1 = Vec::new();
        let mut c2 = Vec::new();
        collect_constructions(body, src, "cid", "m.rs", "fid", &mut c1);
        collect_constructions(body, src, "cid", "m.rs", "fid", &mut c2);
        assert_eq!(c1, c2, "collect_constructions must be deterministic");
    }

    #[test]
    fn other_scoped_methods_do_not_emit_construction() {
        // Only ::new ends up emitting; ::build, ::default, etc. do not (v1 conservative).
        let src = b"fn caller() { let _ = Foo::build(); let _ = Foo::default(); }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_item")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut constructions = Vec::new();
        collect_constructions(body, src, "cid", "m.rs", "fid", &mut constructions);
        assert!(
            constructions.is_empty(),
            "::build / ::default must NOT emit RawConstruction in v1"
        );
    }

    #[test]
    fn grammar_foo_new_is_call_with_scoped_identifier() {
        // Verify: `Foo::new()` parses as call_expression whose `function` child
        // is a scoped_identifier with path=type_identifier "Foo" and name=identifier "new".
        let src = b"fn caller() { let _ = Foo::new(); }";
        let tree = parse(src).unwrap();
        let root = tree.root_node();
        let func = root
            .named_children(&mut root.walk())
            .find(|n| n.kind() == "function_item")
            .unwrap();
        let body = func.child_by_field_name("body").unwrap();
        // let_declaration → call_expression
        let let_decl = body
            .named_children(&mut body.walk())
            .find(|n| n.kind() == "let_declaration")
            .unwrap();
        let call = let_decl
            .named_children(&mut let_decl.walk())
            .find(|n| n.kind() == "call_expression")
            .unwrap();
        let func_node = call.child_by_field_name("function").unwrap();
        assert_eq!(
            func_node.kind(),
            "scoped_identifier",
            "Foo::new() function child must be scoped_identifier"
        );
        let name = func_node
            .child_by_field_name("name")
            .map(|n| reposkein_lang_common::text(n, src).to_string())
            .unwrap_or_default();
        assert_eq!(name, "new");
        let path = func_node
            .child_by_field_name("path")
            .map(|n| reposkein_lang_common::text(n, src).to_string())
            .unwrap_or_default();
        assert_eq!(path, "Foo");
    }
}
