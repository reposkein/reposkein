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
}
