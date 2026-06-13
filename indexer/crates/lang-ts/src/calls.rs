//! Collect call sites inside one function body → RawCall, attributing to the
//! nearest enclosing function (does not descend into nested functions/classes).

use reposkein_core::extractor::RawCall;
use reposkein_lang_common::{text, CallConfig};
use tree_sitter::Node as TsNode;

const CONFIG: CallConfig = CallConfig {
    boundaries: &[
        "function_declaration",
        "function_expression",
        "arrow_function",
        "method_definition",
        "class_declaration",
    ],
    call_kind: "call_expression",
    classify,
};

fn classify(func: TsNode, source: &[u8]) -> (String, Option<String>) {
    match func.kind() {
        "identifier" => (text(func, source).to_string(), None),
        "member_expression" => {
            let name = func
                .child_by_field_name("property")
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
    fn collects_bare_member_and_this_calls() {
        let src =
            b"class C { m() { this.go(); helper(); obj.run(); function inner(){ skip(); } } }";
        let tree = parse(src, false).unwrap();
        let class = tree.root_node().named_child(0).unwrap();
        let body = class.child_by_field_name("body").unwrap();
        let method = body.named_child(0).unwrap();
        let mbody = method.child_by_field_name("body").unwrap();
        let mut calls = Vec::new();
        collect_calls(mbody, src, "cid", "C.m", "m.ts", &mut calls);
        let pairs: Vec<(&str, Option<&str>)> = calls
            .iter()
            .map(|c| (c.callee_name.as_str(), c.receiver.as_deref()))
            .collect();
        assert!(pairs.contains(&("go", Some("this"))));
        assert!(pairs.contains(&("helper", None)));
        assert!(pairs.contains(&("run", Some("obj"))));
        assert!(!pairs.iter().any(|(n, _)| *n == "skip"));
    }
}
