//! Collect call sites inside one function body → RawCall, attributing each
//! call to its nearest enclosing function (does not descend into nested defs).

use reposkein_core::extractor::RawCall;
use tree_sitter::Node as TsNode;

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

/// Recursively gather calls under `node`, attributing to (caller_id, caller_qualified,
/// caller_path). Stops at nested function/class boundaries.
pub fn collect_calls(
    node: TsNode,
    source: &[u8],
    caller_id: &str,
    caller_qualified: &str,
    caller_path: &str,
    out: &mut Vec<RawCall>,
) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "function_definition" | "class_definition" | "decorated_definition" => {
                // Boundary: belongs to a nested scope, scanned separately.
                continue;
            }
            "call" => {
                if let Some(func) = child.child_by_field_name("function") {
                    let (callee_name, receiver) = match func.kind() {
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
                    };
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
                // Descend into the call's children (arguments may contain calls).
                collect_calls(child, source, caller_id, caller_qualified, caller_path, out);
            }
            _ => {
                collect_calls(child, source, caller_id, caller_qualified, caller_path, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    #[test]
    fn decorator_calls_not_attributed_to_enclosing() {
        // A function whose body contains a decorated nested def; the decorator
        // call (register(...)) must NOT be attributed to `outer`.
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
        assert!(names.contains(&("g", None))); // call inside arguments
        assert!(!names.iter().any(|(n, _)| *n == "skip_me")); // nested def excluded
    }
}
