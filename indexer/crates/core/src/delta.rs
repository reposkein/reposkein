//! Old-vs-new node-map diff (`graph_delta`) — the mechanical trigger for
//! decision drift detection. Computed for free during `index`: the previous
//! nodes.jsonl is already read for summary absorption; comparing it against
//! the fresh graph costs one map pass.
//!
//! "Modified" means the node's CONTENT changed: content_hash differs when both
//! sides carry one. Nodes without hashes fall back to a structural-prop
//! comparison that ignores summary fields (authored, not drift) and line
//! positions (a comment added above a function shifts start_line without
//! changing the code a decision governs).

use crate::merge::is_summary_field;
use crate::model::Node;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Ids are capped per list so a bulk change can't bloat stats output; counts
/// stay exact and `truncated` says when the lists are partial.
pub const DELTA_ID_CAP: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DeltaCounts {
    pub added: usize,
    pub removed: usize,
    pub modified: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct GraphDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub modified: Vec<String>,
    pub counts: DeltaCounts,
    pub truncated: bool,
}

impl GraphDelta {
    pub fn is_empty(&self) -> bool {
        self.counts.added == 0 && self.counts.removed == 0 && self.counts.modified == 0
    }
}

fn is_positional(k: &str) -> bool {
    k == "start_line" || k == "end_line"
}

fn comparable(props: &Map<String, Value>) -> Map<String, Value> {
    props
        .iter()
        .filter(|(k, _)| !is_summary_field(k) && !is_positional(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn cap(mut ids: Vec<String>) -> (Vec<String>, bool) {
    ids.sort();
    let truncated = ids.len() > DELTA_ID_CAP;
    ids.truncate(DELTA_ID_CAP);
    (ids, truncated)
}

/// Diffs the previous graph's nodes against the fresh ones. Deterministic:
/// sorted id lists, exact counts, capped lists flagged via `truncated`.
pub fn compute_graph_delta(prev: &[Node], next: &[Node]) -> GraphDelta {
    compute_graph_delta_indexed(&node_fingerprints(prev), next)
}

/// The comparison key for one node: its content hash when it has one, and
/// otherwise the same normalised props the full comparison would have used.
fn fingerprint(node: &Node) -> String {
    match node.props.get("content_hash").and_then(Value::as_str) {
        Some(h) => format!("h:{h}"),
        None => format!("c:{}", Value::Object(comparable(&node.props))),
    }
}

/// Reduce a node set to id -> fingerprint.
///
/// This is what the previous index has to leave behind for the next one to diff
/// against. Retaining the parsed `Vec<Node>` instead kept every label and every
/// prop map alive through the graft, the write and the diff — hundreds of
/// megabytes on a large repository, to answer a question that only needs one
/// string per node.
pub fn node_fingerprints(nodes: &[Node]) -> BTreeMap<String, String> {
    nodes
        .iter()
        .map(|n| (n.id.clone(), fingerprint(n)))
        .collect()
}

/// Diff against fingerprints rather than a retained node set.
pub fn compute_graph_delta_indexed(prev: &BTreeMap<String, String>, next: &[Node]) -> GraphDelta {
    let new: BTreeMap<&str, &Node> = next.iter().map(|n| (n.id.as_str(), n)).collect();

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut modified = Vec::new();
    for (id, node) in &new {
        match prev.get(*id) {
            None => added.push((*id).to_string()),
            Some(prev_fp) => {
                if *prev_fp != fingerprint(node) {
                    modified.push((*id).to_string());
                }
            }
        }
    }
    for id in prev.keys() {
        if !new.contains_key(id.as_str()) {
            removed.push(id.clone());
        }
    }

    let counts = DeltaCounts {
        added: added.len(),
        removed: removed.len(),
        modified: modified.len(),
    };
    let (added, t1) = cap(added);
    let (removed, t2) = cap(removed);
    let (modified, t3) = cap(modified);
    GraphDelta {
        added,
        removed,
        modified,
        counts,
        truncated: t1 || t2 || t3,
    }
}

/// Unions a fresh delta into a previously persisted, not-yet-consumed one —
/// hook-driven indexes may run several times before the MCP server reads the
/// pending delta, and later runs must not erase earlier drift. Counts become
/// union sizes of the (capped) lists; exactness is not worth carrying extra
/// state for a file whose purpose is "something you govern changed — look".
pub fn merge_graph_delta(pending: &GraphDelta, fresh: &GraphDelta) -> GraphDelta {
    let union = |a: &[String], b: &[String]| -> Vec<String> {
        let mut v: Vec<String> = a.iter().chain(b.iter()).cloned().collect();
        v.sort();
        v.dedup();
        v
    };
    let (added, t1) = cap(union(&pending.added, &fresh.added));
    let (removed, t2) = cap(union(&pending.removed, &fresh.removed));
    let (modified, t3) = cap(union(&pending.modified, &fresh.modified));
    let counts = DeltaCounts {
        added: added.len(),
        removed: removed.len(),
        modified: modified.len(),
    };
    GraphDelta {
        added,
        removed,
        modified,
        counts,
        truncated: pending.truncated || fresh.truncated || t1 || t2 || t3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, hash: Option<&str>, extra: &[(&str, Value)]) -> Node {
        let mut props = Map::new();
        if let Some(h) = hash {
            props.insert("content_hash".into(), json!(h));
        }
        for (k, v) in extra {
            props.insert((*k).into(), v.clone());
        }
        Node {
            id: id.into(),
            labels: vec!["Function".into()],
            props,
        }
    }

    #[test]
    fn classifies_added_removed_modified_by_content_hash() {
        let prev = vec![
            node("rs1:r:func:a#f@0", Some("h1"), &[]),
            node("rs1:r:func:a#gone@0", Some("h2"), &[]),
            node("rs1:r:func:a#same@0", Some("h3"), &[]),
        ];
        let next = vec![
            node("rs1:r:func:a#f@0", Some("h1-changed"), &[]),
            node("rs1:r:func:a#same@0", Some("h3"), &[]),
            node("rs1:r:func:a#new@0", Some("h4"), &[]),
        ];
        let d = compute_graph_delta(&prev, &next);
        assert_eq!(d.added, vec!["rs1:r:func:a#new@0"]);
        assert_eq!(d.removed, vec!["rs1:r:func:a#gone@0"]);
        assert_eq!(d.modified, vec!["rs1:r:func:a#f@0"]);
        assert_eq!(
            d.counts,
            DeltaCounts {
                added: 1,
                removed: 1,
                modified: 1
            }
        );
        assert!(!d.truncated);
        assert!(!d.is_empty());
    }

    #[test]
    fn line_shifts_and_summary_edits_are_not_modifications() {
        let prev = vec![node(
            "rs1:r:func:a#f@0",
            Some("h1"),
            &[
                ("start_line", json!(10)),
                ("semantic_summary", json!("old")),
            ],
        )];
        let next = vec![node(
            "rs1:r:func:a#f@0",
            Some("h1"),
            &[
                ("start_line", json!(20)),
                ("semantic_summary", json!("new")),
            ],
        )];
        assert!(compute_graph_delta(&prev, &next).is_empty());
    }

    #[test]
    fn hashless_nodes_fall_back_to_structural_comparison() {
        let prev = vec![node("rs1:r:dir:src", None, &[("child_count", json!(3))])];
        let next_same = vec![node(
            "rs1:r:dir:src",
            None,
            &[("child_count", json!(3)), ("start_line", json!(1))],
        )];
        assert!(compute_graph_delta(&prev, &next_same).is_empty());
        let next_changed = vec![node("rs1:r:dir:src", None, &[("child_count", json!(4))])];
        assert_eq!(compute_graph_delta(&prev, &next_changed).counts.modified, 1);
    }

    #[test]
    fn caps_id_lists_and_keeps_exact_counts() {
        let total = DELTA_ID_CAP + 10;
        let next: Vec<Node> = (0..total)
            .map(|i| node(&format!("rs1:r:func:a#n{i:03}@0"), Some("h"), &[]))
            .collect();
        let d = compute_graph_delta(&[], &next);
        assert_eq!(d.added.len(), DELTA_ID_CAP);
        assert_eq!(d.counts.added, total);
        assert!(d.truncated);
    }

    #[test]
    fn merge_unions_pending_and_fresh() {
        let a = GraphDelta {
            added: vec!["x".into()],
            removed: vec![],
            modified: vec!["m1".into()],
            counts: DeltaCounts {
                added: 1,
                removed: 0,
                modified: 1,
            },
            truncated: false,
        };
        let b = GraphDelta {
            added: vec!["x".into(), "y".into()],
            removed: vec!["r".into()],
            modified: vec!["m2".into()],
            counts: DeltaCounts {
                added: 2,
                removed: 1,
                modified: 1,
            },
            truncated: false,
        };
        let m = merge_graph_delta(&a, &b);
        assert_eq!(m.added, vec!["x".to_string(), "y".to_string()]);
        assert_eq!(m.removed, vec!["r".to_string()]);
        assert_eq!(m.modified, vec!["m1".to_string(), "m2".to_string()]);
        assert_eq!(m.counts.modified, 2);
    }
}
