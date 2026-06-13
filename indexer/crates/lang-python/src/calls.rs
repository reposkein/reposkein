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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

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
