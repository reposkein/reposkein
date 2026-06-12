//! Canonical JSONL serialization (PRD §6.2). Lead keys are emitted first,
//! remaining keys in sorted (BTreeMap) order, no null fields, LF-terminated.

use crate::model::{Edge, Node};
use serde_json::{Map, Value};

/// Serializes one object: `lead` keys first (in the given order, if present),
/// then all other keys in sorted order. No spaces, no trailing comma.
fn canonical_object(obj: &Map<String, Value>, lead: &[&str]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for &k in lead {
        if let Some(v) = obj.get(k) {
            parts.push(format!(
                "{}:{}",
                serde_json::to_string(k).unwrap(),
                serde_json::to_string(v).unwrap()
            ));
        }
    }
    for (k, v) in obj.iter() {
        if lead.contains(&k.as_str()) {
            continue;
        }
        parts.push(format!(
            "{}:{}",
            serde_json::to_string(k).unwrap(),
            serde_json::to_string(v).unwrap()
        ));
    }
    format!("{{{}}}", parts.join(","))
}

/// Builds the full object for a node: id, labels, then properties.
fn node_object(node: &Node) -> Map<String, Value> {
    let mut obj = node.props.clone();
    obj.insert("id".to_string(), Value::String(node.id.clone()));
    obj.insert(
        "labels".to_string(),
        Value::Array(node.labels.iter().cloned().map(Value::String).collect()),
    );
    obj
}

fn edge_object(edge: &Edge) -> Map<String, Value> {
    let mut obj = edge.props.clone();
    obj.insert("from".to_string(), Value::String(edge.from.clone()));
    obj.insert("type".to_string(), Value::String(edge.typ.clone()));
    obj.insert("to".to_string(), Value::String(edge.to.clone()));
    obj
}

pub fn node_line(node: &Node) -> String {
    canonical_object(&node_object(node), &["id", "labels"])
}

pub fn edge_line(edge: &Edge) -> String {
    canonical_object(&edge_object(edge), &["from", "type", "to"])
}

/// Serializes nodes sorted by `id`, one per line, LF-terminated (incl. final).
pub fn nodes_to_jsonl(nodes: &[Node]) -> String {
    let mut sorted: Vec<&Node> = nodes.iter().collect();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    let mut out = String::new();
    for n in sorted {
        out.push_str(&node_line(n));
        out.push('\n');
    }
    out
}

/// Serializes edges sorted by (from, type, to), one per line, LF-terminated.
pub fn edges_to_jsonl(edges: &[Edge]) -> String {
    let mut sorted: Vec<&Edge> = edges.iter().collect();
    sorted.sort_by(|a, b| {
        (a.from.as_str(), a.typ.as_str(), a.to.as_str()).cmp(&(
            b.from.as_str(),
            b.typ.as_str(),
            b.to.as_str(),
        ))
    });
    let mut out = String::new();
    for e in sorted {
        out.push_str(&edge_line(e));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn node_line_orders_id_labels_then_sorted_props() {
        let node = Node::new("rs1:r:file:a.py", "File")
            .set("path", json!("a.py"))
            .set("content_hash", json!("abc"))
            .set("language", json!("python"));
        // id, labels, then content_hash < language < path alphabetically.
        assert_eq!(
            node_line(&node),
            r#"{"id":"rs1:r:file:a.py","labels":["File"],"content_hash":"abc","language":"python","path":"a.py"}"#
        );
    }

    #[test]
    fn edge_line_orders_from_type_to() {
        let edge = Edge::new("rs1:r:dir:.", "CONTAINS", "rs1:r:file:a.py");
        assert_eq!(
            edge_line(&edge),
            r#"{"from":"rs1:r:dir:.","type":"CONTAINS","to":"rs1:r:file:a.py"}"#
        );
    }

    #[test]
    fn nodes_sorted_by_id_and_lf_terminated() {
        let b = Node::new("rs1:r:file:b.py", "File");
        let a = Node::new("rs1:r:file:a.py", "File");
        let out = nodes_to_jsonl(&[b, a]);
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[0].contains("a.py"));
        assert!(lines[1].contains("b.py"));
        assert!(out.ends_with('\n'));
    }
}
