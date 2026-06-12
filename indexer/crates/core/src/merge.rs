//! Deterministic three-way merge of canonical JSONL records (PRD §3.5).
//! Structural fields are indexer-regenerated (take the changed side); summaries
//! are preserved by the content-hash rule.

use crate::model::{Edge, Node};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const SUMMARY_FIELDS: &[&str] = &[
    "semantic_summary",
    "purpose_summary",
    "summary_of_hash",
    "summary_model",
    "summary_at",
    "summary_by",
];

fn is_summary_field(k: &str) -> bool {
    SUMMARY_FIELDS.contains(&k)
}

fn structural(props: &Map<String, Value>) -> Map<String, Value> {
    props
        .iter()
        .filter(|(k, _)| !is_summary_field(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn summary_part(props: &Map<String, Value>) -> Map<String, Value> {
    props
        .iter()
        .filter(|(k, _)| is_summary_field(k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn has_summary(s: &Map<String, Value>) -> bool {
    s.contains_key("semantic_summary") || s.contains_key("purpose_summary")
}

fn node_map(nodes: &[Node]) -> BTreeMap<&str, &Node> {
    nodes.iter().map(|n| (n.id.as_str(), n)).collect()
}

/// Merges one node present on both sides.
fn merge_node(base: Option<&Node>, ours: &Node, theirs: &Node) -> Node {
    let o_struct = structural(&ours.props);
    let t_struct = structural(&theirs.props);
    let chosen_struct = match base {
        Some(b) if structural(&b.props) == o_struct => t_struct, // ours unchanged → theirs
        _ => o_struct,                                           // ours changed / both changed
    };
    let merged_chash = chosen_struct.get("content_hash").cloned();

    let o_sum = summary_part(&ours.props);
    let t_sum = summary_part(&theirs.props);
    let qualifies = |s: &Map<String, Value>| {
        has_summary(s) && s.get("summary_of_hash") == merged_chash.as_ref()
    };
    let base_sum = base.map(|b| summary_part(&b.props));
    let chosen_sum: Map<String, Value> = match (qualifies(&o_sum), qualifies(&t_sum)) {
        (true, true) => {
            if o_sum == t_sum {
                o_sum
            } else if base_sum.as_ref() == Some(&o_sum) {
                t_sum // ours == base → theirs is the fresh write
            } else {
                o_sum // ours changed (or both) → deterministic ours
            }
        }
        (true, false) => o_sum,
        (false, true) => t_sum,
        (false, false) => Map::new(), // drop — regenerate JIT
    };

    let mut props = chosen_struct;
    for (k, v) in chosen_sum {
        props.insert(k, v);
    }
    Node {
        id: ours.id.clone(),
        labels: ours.labels.clone(),
        props,
    }
}

/// Three-way merge of node records, returned sorted by id.
pub fn merge_nodes(base: &[Node], ours: &[Node], theirs: &[Node]) -> Vec<Node> {
    let bm = node_map(base);
    let om = node_map(ours);
    let tm = node_map(theirs);
    let keys: BTreeSet<&str> = om.keys().chain(tm.keys()).copied().collect();
    let mut out = Vec::new();
    for k in keys {
        match (om.get(k), tm.get(k)) {
            (Some(o), Some(t)) => out.push(merge_node(bm.get(k).copied(), o, t)),
            (Some(o), None) => out.push((*o).clone()),
            (None, Some(t)) => out.push((*t).clone()),
            (None, None) => {}
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn edge_key(e: &Edge) -> (String, String, String) {
    (e.from.clone(), e.typ.clone(), e.to.clone())
}

/// Carries summaries from `existing` records onto freshly-regenerated `fresh`
/// records, keyed by id, keeping a summary only when its `summary_of_hash`
/// still matches the fresh record's `content_hash` (PRD §3.5/§4.1.6). Fresh
/// structure always wins; stale summaries are dropped (regenerated JIT).
pub fn graft_summaries(fresh: &[Node], existing: &[Node]) -> Vec<Node> {
    let ex = node_map(existing);
    fresh
        .iter()
        .map(|f| {
            let mut node = f.clone();
            if let Some(old) = ex.get(f.id.as_str()) {
                let old_sum = summary_part(&old.props);
                if has_summary(&old_sum)
                    && old_sum.get("summary_of_hash") == f.props.get("content_hash")
                {
                    for (k, v) in old_sum {
                        node.props.insert(k, v);
                    }
                }
            }
            node
        })
        .collect()
}

/// Three-way merge of edge records (all fields structural; ours-wins on
/// conflict). Returned sorted by (from, type, to).
pub fn merge_edges(_base: &[Edge], ours: &[Edge], theirs: &[Edge]) -> Vec<Edge> {
    let mut map: BTreeMap<(String, String, String), Edge> = BTreeMap::new();
    for e in theirs {
        map.insert(edge_key(e), e.clone());
    }
    for e in ours {
        map.insert(edge_key(e), e.clone()); // ours overwrites theirs
    }
    map.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn func(id: &str, chash: &str) -> Node {
        Node::new(id, "Function")
            .set("qualified_name", json!(id))
            .set("content_hash", json!(chash))
    }
    fn with_summary(mut n: Node, text: &str, of_hash: &str) -> Node {
        n.props.insert("semantic_summary".into(), json!(text));
        n.props.insert("summary_of_hash".into(), json!(of_hash));
        n
    }

    #[test]
    fn independent_summaries_on_different_nodes_both_survive() {
        let a = func("rs1:r:func:a#f@0", "ha");
        let b = func("rs1:r:func:b#g@0", "hb");
        let base = vec![a.clone(), b.clone()];
        // ours summarizes A; theirs summarizes B.
        let ours = vec![with_summary(a.clone(), "does A", "ha"), b.clone()];
        let theirs = vec![a.clone(), with_summary(b.clone(), "does B", "hb")];
        let merged = merge_nodes(&base, &ours, &theirs);
        let get = |id: &str| merged.iter().find(|n| n.id == id).unwrap();
        assert_eq!(
            get("rs1:r:func:a#f@0").props["semantic_summary"],
            json!("does A")
        );
        assert_eq!(
            get("rs1:r:func:b#g@0").props["semantic_summary"],
            json!("does B")
        );
    }

    #[test]
    fn same_node_conflict_resolves_deterministically_by_hash() {
        let a = func("rs1:r:func:a#f@0", "ha");
        let base = vec![a.clone()];
        let ours = vec![with_summary(a.clone(), "ours text", "ha")];
        let theirs = vec![with_summary(a.clone(), "theirs text", "ha")];
        let merged = merge_nodes(&base, &ours, &theirs);
        // Both stamped to current hash → deterministic single winner (ours), no conflict marker.
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].props["semantic_summary"], json!("ours text"));
    }

    #[test]
    fn stale_summary_against_merged_source_is_dropped() {
        // Theirs changed the source (content_hash hb) but ours wrote a summary
        // against the old hash (ha). Merged structural takes theirs (ha->hb);
        // ours' summary no longer matches → dropped.
        let base = vec![func("rs1:r:func:a#f@0", "ha")];
        let ours = vec![with_summary(
            func("rs1:r:func:a#f@0", "ha"),
            "old summary",
            "ha",
        )];
        let theirs = vec![func("rs1:r:func:a#f@0", "hb")];
        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged[0].props["content_hash"], json!("hb"));
        assert!(!merged[0].props.contains_key("semantic_summary"));
    }

    #[test]
    fn edges_union_with_ours_winning() {
        let base: Vec<Edge> = vec![];
        let ours = vec![Edge::new("a", "CALLS", "b")];
        let theirs = vec![Edge::new("a", "CALLS", "c")];
        let merged = merge_edges(&base, &ours, &theirs);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn graft_keeps_matching_summary_and_drops_stale() {
        // Fresh structure for two functions; existing has a summary for each.
        let fresh = vec![func("rs1:r:func:a#f@0", "ha"), func("rs1:r:func:b#g@0", "hb_new")];
        let existing = vec![
            with_summary(func("rs1:r:func:a#f@0", "ha"), "stable summary", "ha"), // hash matches → kept
            with_summary(func("rs1:r:func:b#g@0", "hb_old"), "old summary", "hb_old"), // source changed (hb_old→hb_new) → dropped
        ];
        let out = graft_summaries(&fresh, &existing);
        let get = |id: &str| out.iter().find(|n| n.id == id).unwrap();
        assert_eq!(get("rs1:r:func:a#f@0").props["semantic_summary"], json!("stable summary"));
        assert!(!get("rs1:r:func:b#g@0").props.contains_key("semantic_summary"));
    }

    #[test]
    fn graft_leaves_new_nodes_untouched() {
        let fresh = vec![func("rs1:r:func:c#h@0", "hc")];
        let out = graft_summaries(&fresh, &[]);
        assert_eq!(out.len(), 1);
        assert!(!out[0].props.contains_key("semantic_summary"));
    }
}
