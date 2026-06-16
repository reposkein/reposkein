//! Collect call sites inside one function body → RawCall, attributing each
//! call to its nearest enclosing function (does not descend into nested defs).

use reposkein_core::extractor::RawCall;
use reposkein_lang_common::{text, CallConfig};
use tree_sitter::Node as TsNode;

const CONFIG: CallConfig = CallConfig {
    boundaries: &[
        "function_definition",
        "class_definition",
        "decorated_definition",
    ],
    call_kind: "call",
    classify,
};

fn classify(func: TsNode, source: &[u8]) -> (String, Option<String>) {
    match func.kind() {
        "identifier" => (text(func, source).to_string(), None),
        "attribute" => {
            let name = func
                .child_by_field_name("attribute")
                .map(|n| text(n, source).to_string())
                .unwrap_or_default();
            let recv = func
                .child_by_field_name("object")
                .map(|n| text(n, source).to_string());
            (name, recv)
        }
        _ => (String::new(), None),
    }
}

/// Gathers calls under `node` (see `reposkein_lang_common::collect_calls`).
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

/// Collects bound-local construction sites from Python function bodies.
///
/// Matches `assignment` nodes where:
/// - `left` is a single `identifier`
/// - `right` is a `call` whose `function` is an `identifier` or `attribute`
///
/// Emits `RawConstruction { class_name, bound_local: Some(lhs), .. }` for the
/// receiver-type tracker. These are NOT fed to INSTANTIATES resolution (Python
/// INSTANTIATES continues via the existing class-lift path in resolve_full).
///
/// Boundaries: function_definition, class_definition, lambda (do not descend).
pub fn collect_receiver_bindings(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<reposkein_core::extractor::RawConstruction>,
) {
    const BOUNDARIES: &[&str] = &["function_definition", "class_definition", "lambda"];
    collect_receiver_bindings_inner(
        node,
        source,
        caller_id,
        caller_path,
        caller_file_id,
        out,
        BOUNDARIES,
    );
}

fn collect_receiver_bindings_inner(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_path: &str,
    caller_file_id: &str,
    out: &mut Vec<reposkein_core::extractor::RawConstruction>,
    boundaries: &[&str],
) {
    if node.kind() == "assignment" {
        // left field must be a single identifier
        if let Some(left) = node.child_by_field_name("left") {
            if left.kind() == "identifier" {
                let lhs = text(left, source).to_string();
                // right field must be a `call` node
                if let Some(right) = node.child_by_field_name("right") {
                    if right.kind() == "call" {
                        // The call's `function` field gives us the callee name
                        if let Some(func_node) = right.child_by_field_name("function") {
                            let class_name = match func_node.kind() {
                                "identifier" => {
                                    let s = text(func_node, source).to_string();
                                    if s.is_empty() {
                                        None
                                    } else {
                                        Some(s)
                                    }
                                }
                                "attribute" => {
                                    // `pkg.Foo()` → take the attribute (last segment)
                                    func_node
                                        .child_by_field_name("attribute")
                                        .map(|n| text(n, source).to_string())
                                        .filter(|s| !s.is_empty())
                                }
                                _ => None,
                            };
                            if let Some(cn) = class_name {
                                out.push(reposkein_core::extractor::RawConstruction {
                                    caller_id: caller_id.to_string(),
                                    caller_path: caller_path.to_string(),
                                    caller_file_id: caller_file_id.to_string(),
                                    class_name: cn,
                                    bound_local: Some(lhs),
                                });
                            }
                        }
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
        collect_receiver_bindings_inner(
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
    fn python_assignment_with_call_rhs_emits_bound_local() {
        let src = b"def f():\n    x = Foo()\n    x.bar()\n";
        let tree = parse(src).unwrap();
        let func = tree.root_node().named_child(0).unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut bindings = Vec::new();
        collect_receiver_bindings(body, src, "cid", "m.py", "fid", &mut bindings);
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].class_name, "Foo");
        assert_eq!(bindings[0].bound_local, Some("x".to_string()));
    }

    #[test]
    fn python_augmented_assignment_not_collected() {
        // `x = Foo()` is a regular assignment → captured.
        let src = b"def f():\n    x = Foo()\n";
        let tree = parse(src).unwrap();
        let func = tree.root_node().named_child(0).unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut bindings = Vec::new();
        collect_receiver_bindings(body, src, "cid", "m.py", "fid", &mut bindings);
        assert_eq!(bindings.len(), 1, "regular assignment captured");
        assert_eq!(bindings[0].bound_local, Some("x".to_string()));
    }

    #[test]
    fn python_tuple_lhs_not_collected() {
        // `x, y = 1, 2` → left is a pattern_list, not identifier → skip
        let src = b"def f():\n    x, y = 1, 2\n";
        let tree = parse(src).unwrap();
        let func = tree.root_node().named_child(0).unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut bindings = Vec::new();
        collect_receiver_bindings(body, src, "cid", "m.py", "fid", &mut bindings);
        assert!(bindings.is_empty(), "tuple LHS must not be collected");
    }

    #[test]
    fn python_does_not_descend_into_nested_def() {
        let src = b"def outer():\n    x = Foo()\n    def inner():\n        y = Bar()\n";
        let tree = parse(src).unwrap();
        let func = tree.root_node().named_child(0).unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut bindings = Vec::new();
        collect_receiver_bindings(body, src, "outer_id", "m.py", "fid", &mut bindings);
        assert_eq!(
            bindings.len(),
            1,
            "should only collect from outer, not inner def"
        );
        assert_eq!(bindings[0].class_name, "Foo");
    }

    #[test]
    fn decorator_calls_not_attributed_to_enclosing() {
        let src =
            b"def outer():\n    helper()\n    @register(\"x\")\n    def inner():\n        pass\n";
        let tree = parse(src).unwrap();
        let func = tree.root_node().named_child(0).unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut calls = Vec::new();
        collect_calls(body, src, "cid", "outer", "m.py", &mut calls);
        let names: Vec<&str> = calls.iter().map(|c| c.callee_name.as_str()).collect();
        assert!(names.contains(&"helper"));
        assert!(
            !names.contains(&"register"),
            "decorator call must not attribute to outer"
        );
        assert!(!names.contains(&"inner"));
    }

    #[test]
    fn collects_bare_and_attribute_calls_excluding_nested_defs() {
        let src = b"def outer():\n    helper()\n    obj.method(g())\n    def inner():\n        skip_me()\n";
        let tree = parse(src).unwrap();
        let func = tree.root_node().named_child(0).unwrap();
        let body = func.child_by_field_name("body").unwrap();
        let mut calls = Vec::new();
        collect_calls(body, src, "cid", "outer", "m.py", &mut calls);
        let names: Vec<(&str, Option<&str>)> = calls
            .iter()
            .map(|c| (c.callee_name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(names.contains(&("helper", None)));
        assert!(names.contains(&("method", Some("obj"))));
        assert!(names.contains(&("g", None)));
        assert!(!names.iter().any(|(n, _)| *n == "skip_me"));
    }
}
