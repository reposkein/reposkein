//! In-memory node/edge records. Properties live in a serde_json::Map
//! (a BTreeMap when serde_json's `preserve_order` feature is OFF), which
//! gives sorted property keys for free — the canonical writer depends on this.
//! The `determinism_serde_json_map_is_btree` test in `jsonl.rs` guards this
//! assumption: it inserts keys in scrambled order and asserts sorted output,
//! failing loudly if `preserve_order` ever leaks into `reposkein-core`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub labels: Vec<String>,
    pub props: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub typ: String,
    pub to: String,
    pub props: Map<String, Value>,
}

impl Node {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Node {
            id: id.into(),
            labels: vec![label.into()],
            props: Map::new(),
        }
    }

    /// Inserts a property. Skips the insert when `value` is `Value::Null`
    /// so optional/absent fields never reach committed output (PRD §6.2.4).
    pub fn set(mut self, key: &str, value: Value) -> Self {
        if !value.is_null() {
            self.props.insert(key.to_string(), value);
        }
        self
    }
}

impl Edge {
    pub fn new(from: impl Into<String>, typ: impl Into<String>, to: impl Into<String>) -> Self {
        Edge {
            from: from.into(),
            typ: typ.into(),
            to: to.into(),
            props: Map::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn node_builder_skips_null_props() {
        let n = Node::new("rs1:r:file:a.py", "File")
            .set("language", json!("python"))
            .set("missing", Value::Null);
        assert_eq!(n.labels, vec!["File".to_string()]);
        assert!(n.props.contains_key("language"));
        assert!(!n.props.contains_key("missing"));
    }
}
