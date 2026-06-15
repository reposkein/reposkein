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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

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
