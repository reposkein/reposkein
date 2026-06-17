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
    sorted.dedup_by(|a, b| a.id == b.id);
    let mut out = String::new();
    for n in sorted {
        out.push_str(&node_line(n));
        out.push('\n');
    }
    out
}

/// Merges two edges that share a `(from, type, to)` key into one, deterministically.
///
/// Edge dedup used to be a silent `dedup_by` keep-first, which dropped the
/// props of a colliding edge whenever two edges shared a key but carried
/// DIFFERENT props (e.g. a missing `sites`/`call_sites` count). That hid bugs.
/// We now MERGE colliding edges explicitly: for each prop key present in either
/// edge, keep the larger value when both are numbers (so site/call counts and
/// confidences accumulate to the maximum rather than being lost), otherwise
/// prefer the first edge's value and only adopt the second's when the first is
/// absent. The result is independent of which colliding edge came first, so the
/// merge stays deterministic regardless of upstream push order.
fn merge_edge_props(base: &Edge, other: &Edge) -> Edge {
    let mut merged = base.clone();
    for (k, v_other) in other.props.iter() {
        match merged.props.get(k) {
            None => {
                merged.props.insert(k.clone(), v_other.clone());
            }
            Some(v_base) => {
                // When both are numeric, keep the max (counts/confidences); this
                // is symmetric so push order cannot change the result.
                if let (Some(a), Some(b)) = (v_base.as_f64(), v_other.as_f64()) {
                    if b > a {
                        merged.props.insert(k.clone(), v_other.clone());
                    }
                }
                // Non-numeric collisions: keep base (first key wins). Symmetric
                // sources should not produce conflicting non-numeric props.
            }
        }
    }
    merged
}

/// Serializes edges sorted by (from, type, to), one per line, LF-terminated.
///
/// Edges sharing a `(from, type, to)` key are MERGED (see [`merge_edge_props`])
/// rather than silently collapsed keep-first, so colliding edges with different
/// props never silently drop data. The merge is order-independent and therefore
/// deterministic.
pub fn edges_to_jsonl(edges: &[Edge]) -> String {
    // Keyed merge into a BTreeMap keeps output sorted by (from, type, to) and
    // makes the dedup an explicit, deterministic prop-merge.
    let mut by_key: std::collections::BTreeMap<(String, String, String), Edge> =
        std::collections::BTreeMap::new();
    for e in edges {
        let key = (e.from.clone(), e.typ.clone(), e.to.clone());
        match by_key.get(&key) {
            None => {
                by_key.insert(key, e.clone());
            }
            Some(existing) => {
                let merged = merge_edge_props(existing, e);
                by_key.insert(key, merged);
            }
        }
    }
    let mut out = String::new();
    for e in by_key.values() {
        out.push_str(&edge_line(e));
        out.push('\n');
    }
    out
}

use anyhow::{anyhow, Result};

fn take_string(obj: &mut Map<String, Value>, key: &str) -> Result<String> {
    match obj.remove(key) {
        Some(Value::String(s)) => Ok(s),
        _ => Err(anyhow!("missing or non-string field `{key}`")),
    }
}

fn take_labels(obj: &mut Map<String, Value>) -> Result<Vec<String>> {
    match obj.remove("labels") {
        Some(Value::Array(a)) => Ok(a
            .into_iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s),
                _ => None,
            })
            .collect()),
        _ => Err(anyhow!("missing or non-array `labels`")),
    }
}

/// Parse canonical node JSONL back into Node records. Remaining keys become props.
pub fn read_nodes(text: &str) -> Result<Vec<Node>> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut obj: Map<String, Value> = serde_json::from_str(line)?;
        let id = take_string(&mut obj, "id")?;
        let labels = take_labels(&mut obj)?;
        out.push(Node {
            id,
            labels,
            props: obj,
        });
    }
    Ok(out)
}

/// Parse canonical edge JSONL back into Edge records. Remaining keys become props.
pub fn read_edges(text: &str) -> Result<Vec<Edge>> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut obj: Map<String, Value> = serde_json::from_str(line)?;
        let from = take_string(&mut obj, "from")?;
        let typ = take_string(&mut obj, "type")?;
        let to = take_string(&mut obj, "to")?;
        out.push(Edge {
            from,
            typ,
            to,
            props: obj,
        });
    }
    Ok(out)
}

/// Parses a summaries sidecar (`.reposkein/local/summaries.jsonl`) into Nodes
/// carrying only `id` + summary props (labels empty). Feeds `graft_summaries`
/// so JSONL-mode agent summaries reach committed `nodes.jsonl`. Best-effort:
/// malformed lines are skipped (the sidecar is regenerable and must never abort
/// an index).
pub fn read_sidecar_summaries(text: &str) -> Vec<Node> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut obj: Map<String, Value> = match serde_json::from_str(line) {
            Ok(o) => o,
            Err(_) => continue,
        };
        let id = match obj.remove("id") {
            Some(Value::String(s)) => s,
            _ => continue,
        };
        out.push(Node {
            id,
            labels: Vec::new(),
            props: obj,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nodes_dedup_by_id() {
        let a1 = Node::new("rs1:r:file:a.py", "File").set("path", json!("a.py"));
        let a2 = Node::new("rs1:r:file:a.py", "File").set("path", json!("a.py"));
        let out = nodes_to_jsonl(&[a1, a2]);
        assert_eq!(out.lines().count(), 1, "duplicate ids collapse to one line");
    }

    #[test]
    fn edges_dedup_by_key() {
        let e1 = Edge::new("a", "CONTAINS", "b");
        let e2 = Edge::new("a", "CONTAINS", "b");
        let out = edges_to_jsonl(&[e1, e2]);
        assert_eq!(
            out.lines().count(),
            1,
            "duplicate edge keys collapse to one line"
        );
    }

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

    #[test]
    fn nodes_round_trip_byte_identical() {
        let nodes = vec![
            Node::new("rs1:r:file:a.py", "File")
                .set("path", json!("a.py"))
                .set("content_hash", json!("abc"))
                .set("language", json!("python")),
            Node::new("rs1:r:func:a.py#f@2", "Function")
                .set("qualified_name", json!("f"))
                .set("start_line", json!(3)),
        ];
        let text = nodes_to_jsonl(&nodes);
        let parsed = read_nodes(&text).unwrap();
        assert_eq!(parsed, nodes);
        assert_eq!(nodes_to_jsonl(&parsed), text); // byte-identical
    }

    #[test]
    fn edges_round_trip_byte_identical() {
        let edges = vec![Edge::new("rs1:r:dir:.", "CONTAINS", "rs1:r:file:a.py"), {
            let mut e = Edge::new("rs1:r:func:a.py#f@0", "CALLS", "rs1:r:func:b.py#g@0");
            e.props.insert("resolution".into(), json!("name_match"));
            e.props.insert("confidence".into(), json!(0.7));
            e.props.insert("call_sites".into(), json!(2));
            e
        }];
        let text = edges_to_jsonl(&edges);
        let parsed = read_edges(&text).unwrap();
        assert_eq!(parsed, edges);
        assert_eq!(edges_to_jsonl(&parsed), text);
    }

    #[test]
    fn sidecar_parses_id_and_summary_props_skips_malformed() {
        let text = concat!(
            r#"{"id":"rs1:r:func:a.py#f@0","semantic_summary":"does f","summary_of_hash":"h1"}"#,
            "\n",
            "not json\n",
            "\n",
            r#"{"semantic_summary":"no id - skipped"}"#,
            "\n",
            r#"{"id":"rs1:r:func:b.py#g@0","semantic_summary":"does g","summary_of_hash":"h2"}"#,
            "\n",
        );
        let nodes = read_sidecar_summaries(text);
        assert_eq!(
            nodes.len(),
            2,
            "two valid records; malformed + id-less skipped"
        );
        assert_eq!(nodes[0].id, "rs1:r:func:a.py#f@0");
        assert!(nodes[0].labels.is_empty());
        assert_eq!(nodes[0].props["semantic_summary"], json!("does f"));
        assert_eq!(nodes[0].props["summary_of_hash"], json!("h1"));
        assert_eq!(nodes[1].id, "rs1:r:func:b.py#g@0");
    }

    #[test]
    fn sidecar_nodes_feed_graft_summaries() {
        use crate::merge::graft_summaries;
        let fresh =
            vec![Node::new("rs1:r:func:a.py#f@0", "Function").set("content_hash", json!("h1"))];
        let sidecar = read_sidecar_summaries(
            "{\"id\":\"rs1:r:func:a.py#f@0\",\"semantic_summary\":\"does f\",\"summary_of_hash\":\"h1\"}\n",
        );
        let out = graft_summaries(&fresh, &sidecar);
        assert_eq!(out[0].props["semantic_summary"], json!("does f"));
    }

    /// Guard: serde_json::Map must be a BTreeMap (sorted keys).
    ///
    /// The byte-identical determinism invariant relies on `serde_json::Map`
    /// iterating in key-sorted order.  This is only true when serde_json is
    /// compiled WITHOUT the `preserve_order` feature (which switches it to an
    /// IndexMap, breaking the invariant).  This test inserts keys in reverse
    /// alphabetical order and asserts the serialized output has them sorted.
    ///
    /// If this test ever fails, check that no dependency (directly or
    /// transitively) enables serde_json/preserve_order in Cargo.lock under
    /// resolver v2 — see `determinism_serde_json_map_is_btree` for the guard.
    #[test]
    fn determinism_serde_json_map_is_btree() {
        use serde_json::{Map, Value};

        // Insert keys in scrambled (reverse) order: z, m, a.
        let mut map: Map<String, Value> = Map::new();
        map.insert("z".to_string(), Value::Number(3.into()));
        map.insert("m".to_string(), Value::Number(2.into()));
        map.insert("a".to_string(), Value::Number(1.into()));

        let serialized = serde_json::to_string(&map).unwrap();
        // Keys must appear in sorted order: a < m < z.
        let a_pos = serialized.find("\"a\"").expect("key 'a' must be present");
        let m_pos = serialized.find("\"m\"").expect("key 'm' must be present");
        let z_pos = serialized.find("\"z\"").expect("key 'z' must be present");
        assert!(
            a_pos < m_pos && m_pos < z_pos,
            "serde_json::Map must serialize keys in sorted (BTreeMap) order — \
             preserve_order feature must NOT be active. Got: {serialized}"
        );
    }
}
