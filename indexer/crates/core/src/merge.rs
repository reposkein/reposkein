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
            (Some(o), None) => {
                // theirs deleted it; keep only if ours changed it from base.
                match bm.get(k) {
                    Some(b) if *b == *o => {} // unchanged + deleted-by-theirs → drop
                    _ => out.push((*o).clone()),
                }
            }
            (None, Some(t)) => {
                // ours deleted it; keep only if theirs changed it from base.
                match bm.get(k) {
                    Some(b) if *b == *t => {} // unchanged + deleted-by-ours → drop
                    _ => out.push((*t).clone()),
                }
            }
            (None, None) => {}
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
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
/// conflict). Edges deleted on one side and unchanged on the other are dropped.
/// Returned sorted by (from, type, to).
pub fn merge_edges(base: &[Edge], ours: &[Edge], theirs: &[Edge]) -> Vec<Edge> {
    let key = |e: &Edge| (e.from.clone(), e.typ.clone(), e.to.clone());
    let bset: BTreeSet<_> = base.iter().map(key).collect();
    let omap: BTreeMap<_, Edge> = ours.iter().map(|e| (key(e), e.clone())).collect();
    let tmap: BTreeMap<_, Edge> = theirs.iter().map(|e| (key(e), e.clone())).collect();
    let mut out: BTreeMap<_, Edge> = BTreeMap::new();
    let all_keys: BTreeSet<_> = omap.keys().chain(tmap.keys()).cloned().collect();
    for k in all_keys {
        match (omap.get(&k), tmap.get(&k)) {
            (Some(o), Some(_)) => {
                out.insert(k, o.clone()); // both: ours-wins (props regenerate)
            }
            (Some(o), None) => {
                // theirs deleted; keep only if ours newly added it (not in base)
                if !bset.contains(&k) {
                    out.insert(k, o.clone());
                }
            }
            (None, Some(t)) => {
                // ours deleted; keep only if theirs newly added it (not in base)
                if !bset.contains(&k) {
                    out.insert(k, t.clone());
                }
            }
            (None, None) => {}
        }
    }
    out.into_values().collect()
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
        let fresh = vec![
            func("rs1:r:func:a#f@0", "ha"),
            func("rs1:r:func:b#g@0", "hb_new"),
        ];
        let existing = vec![
            with_summary(func("rs1:r:func:a#f@0", "ha"), "stable summary", "ha"), // hash matches → kept
            with_summary(func("rs1:r:func:b#g@0", "hb_old"), "old summary", "hb_old"), // source changed (hb_old→hb_new) → dropped
        ];
        let out = graft_summaries(&fresh, &existing);
        let get = |id: &str| out.iter().find(|n| n.id == id).unwrap();
        assert_eq!(
            get("rs1:r:func:a#f@0").props["semantic_summary"],
            json!("stable summary")
        );
        assert!(!get("rs1:r:func:b#g@0")
            .props
            .contains_key("semantic_summary"));
    }

    #[test]
    fn graft_leaves_new_nodes_untouched() {
        let fresh = vec![func("rs1:r:func:c#h@0", "hc")];
        let out = graft_summaries(&fresh, &[]);
        assert_eq!(out.len(), 1);
        assert!(!out[0].props.contains_key("semantic_summary"));
    }

    #[test]
    fn one_sided_deletion_of_unchanged_node_is_dropped() {
        let n = func("rs1:r:func:m.py#f@0", "h");
        let base = vec![n.clone()];
        let ours = vec![n.clone()]; // ours unchanged
        let theirs: Vec<Node> = vec![]; // theirs deleted it
        let merged = merge_nodes(&base, &ours, &theirs);
        assert!(
            merged.is_empty(),
            "a node deleted on one side and unchanged on the other is dropped"
        );
    }

    #[test]
    fn one_sided_deletion_but_modified_other_side_is_kept() {
        let base = vec![func("rs1:r:func:m.py#f@0", "h1")];
        let ours = vec![func("rs1:r:func:m.py#f@0", "h2")]; // ours changed it
        let theirs: Vec<Node> = vec![]; // theirs deleted it
        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged.len(), 1, "modify-vs-delete keeps the modified side");
    }

    // ----- 3-way merge matrix: {structure change} x {summary change} -----
    //
    // Exhaustively exercises `merge_node`'s two independent decisions:
    //   1. structural pick (base/ours/theirs) — see `chosen_struct`
    //   2. summary graft — only grafts when `summary_of_hash == merged_chash`
    //
    // The matrix is built from a fixed base node and parameterised by how each
    // side mutates structure (the `content_hash`) and the summary.

    const ID: &str = "rs1:r:func:matrix.py#f@0";

    /// One side of the matrix: which content_hash it carries, and an optional
    /// summary (text, summary_of_hash).
    #[derive(Clone)]
    struct Side {
        chash: &'static str,
        summary: Option<(&'static str, &'static str)>,
    }

    fn side_node(s: &Side) -> Node {
        let n = func(ID, s.chash);
        match s.summary {
            Some((text, of)) => with_summary(n, text, of),
            None => n,
        }
    }

    /// Structural mutation axis. The base hash is always "h_base".
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum StructChange {
        Neither,    // ours == theirs == base structurally
        OursOnly,   // ours changed, theirs == base
        TheirsOnly, // theirs changed, ours == base
        Both,       // ours and theirs both changed (to different hashes)
    }

    /// Summary mutation axis (orthogonal to structure).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum SummaryChange {
        Absent,     // no summary on either side
        OursOnly,   // only ours carries a summary
        TheirsOnly, // only theirs carries a summary
        Both,       // both sides carry a (differing) summary
    }

    /// Computes the (ours_hash, theirs_hash) and the structurally-expected
    /// merged content_hash for a given `StructChange`, matching `chosen_struct`:
    /// theirs wins only when ours is structurally identical to base.
    fn struct_hashes(sc: StructChange) -> (&'static str, &'static str, &'static str) {
        match sc {
            // ours == base → theirs wins (theirs == base here too → "h_base")
            StructChange::Neither => ("h_base", "h_base", "h_base"),
            // ours changed, theirs == base → ours wins
            StructChange::OursOnly => ("h_ours", "h_base", "h_ours"),
            // ours == base → theirs wins
            StructChange::TheirsOnly => ("h_base", "h_theirs", "h_theirs"),
            // both changed → ours wins (deterministic ours-on-conflict)
            StructChange::Both => ("h_ours", "h_theirs", "h_ours"),
        }
    }

    /// Drives one matrix cell and returns the merged node, the expected merged
    /// content_hash, and the (ours_sum, theirs_sum) summaries that were placed
    /// (already stamped to the merged hash so they *can* graft).
    fn run_cell(
        sc: StructChange,
        mc: SummaryChange,
    ) -> (
        Node,
        &'static str,
        Option<&'static str>,
        Option<&'static str>,
    ) {
        let (oh, th, expected) = struct_hashes(sc);

        // Summaries are stamped against the *expected merged* hash so the graft
        // rule (summary_of_hash == merged_chash) is satisfied; this isolates the
        // summary-pick branch from the staleness-drop branch.
        let (ours_text, theirs_text) = match mc {
            SummaryChange::Absent => (None, None),
            SummaryChange::OursOnly => (Some("ours summary"), None),
            SummaryChange::TheirsOnly => (None, Some("theirs summary")),
            SummaryChange::Both => (Some("ours summary"), Some("theirs summary")),
        };

        let base = vec![func(ID, "h_base")];
        let ours = vec![side_node(&Side {
            chash: oh,
            summary: ours_text.map(|t| (t, expected)),
        })];
        let theirs = vec![side_node(&Side {
            chash: th,
            summary: theirs_text.map(|t| (t, expected)),
        })];

        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged.len(), 1, "single node always survives the merge");
        (
            merged.into_iter().next().unwrap(),
            expected,
            ours_text,
            theirs_text,
        )
    }

    #[test]
    fn matrix_structure_pick_is_deterministic() {
        for sc in [
            StructChange::Neither,
            StructChange::OursOnly,
            StructChange::TheirsOnly,
            StructChange::Both,
        ] {
            for mc in [
                SummaryChange::Absent,
                SummaryChange::OursOnly,
                SummaryChange::TheirsOnly,
                SummaryChange::Both,
            ] {
                let (merged, expected, _, _) = run_cell(sc, mc);
                assert_eq!(
                    merged.props["content_hash"],
                    json!(expected),
                    "structure pick for {sc:?} x {mc:?}: expected merged hash {expected}"
                );
            }
        }
    }

    #[test]
    fn matrix_summary_graft_follows_pick_rule() {
        for sc in [
            StructChange::Neither,
            StructChange::OursOnly,
            StructChange::TheirsOnly,
            StructChange::Both,
        ] {
            for mc in [
                SummaryChange::Absent,
                SummaryChange::OursOnly,
                SummaryChange::TheirsOnly,
                SummaryChange::Both,
            ] {
                let (merged, _, ours_sum, theirs_sum) = run_cell(sc, mc);
                let got = merged
                    .props
                    .get("semantic_summary")
                    .and_then(|v| v.as_str());

                // Expected summary pick (all summaries are stamped to the merged
                // hash here, so each present summary qualifies):
                //   - both present, differing → deterministic ours
                //   - only one present → that one
                //   - none present → none grafted
                let expected = match (ours_sum, theirs_sum) {
                    (Some(o), Some(_)) => Some(o), // ours wins on conflict
                    (Some(o), None) => Some(o),
                    (None, Some(t)) => Some(t),
                    (None, None) => None,
                };
                assert_eq!(
                    got, expected,
                    "summary graft for {sc:?} x {mc:?}: expected {expected:?}"
                );
                // When no summary grafted, none of the summary fields leak in.
                if expected.is_none() {
                    assert!(
                        !merged.props.contains_key("semantic_summary")
                            && !merged.props.contains_key("summary_of_hash"),
                        "no summary fields should leak for {sc:?} x {mc:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn matrix_is_deterministic_across_repeated_merges() {
        for sc in [
            StructChange::Neither,
            StructChange::OursOnly,
            StructChange::TheirsOnly,
            StructChange::Both,
        ] {
            for mc in [
                SummaryChange::Absent,
                SummaryChange::OursOnly,
                SummaryChange::TheirsOnly,
                SummaryChange::Both,
            ] {
                let (oh, th, expected) = struct_hashes(sc);
                let (ours_text, theirs_text) = match mc {
                    SummaryChange::Absent => (None, None),
                    SummaryChange::OursOnly => (Some("ours summary"), None),
                    SummaryChange::TheirsOnly => (None, Some("theirs summary")),
                    SummaryChange::Both => (Some("ours summary"), Some("theirs summary")),
                };
                let base = vec![func(ID, "h_base")];
                let ours = vec![side_node(&Side {
                    chash: oh,
                    summary: ours_text.map(|t| (t, expected)),
                })];
                let theirs = vec![side_node(&Side {
                    chash: th,
                    summary: theirs_text.map(|t| (t, expected)),
                })];
                let first = merge_nodes(&base, &ours, &theirs);
                let second = merge_nodes(&base, &ours, &theirs);
                assert_eq!(
                    first, second,
                    "merge must be deterministic for {sc:?} x {mc:?}"
                );
            }
        }
    }

    /// The headline case the audit flagged: structure AND summary both diverge
    /// on both sides simultaneously. Structure must be ours (h_ours) and the
    /// grafted summary must be ours, and re-merging is identical.
    #[test]
    fn structure_and_summary_diverge_on_both_sides_is_deterministic_ours() {
        let base = vec![func(ID, "h_base")];
        // both sides change structure to *different* hashes AND both write a
        // summary stamped to their own new hash.
        let ours = vec![with_summary(func(ID, "h_ours"), "ours text", "h_ours")];
        let theirs = vec![with_summary(
            func(ID, "h_theirs"),
            "theirs text",
            "h_theirs",
        )];

        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged.len(), 1);
        // Structural pick: both changed → ours wins.
        assert_eq!(merged[0].props["content_hash"], json!("h_ours"));
        // ours' summary is stamped to h_ours == merged hash → qualifies & wins.
        // theirs' summary is stamped to h_theirs != merged hash → disqualified.
        assert_eq!(merged[0].props["semantic_summary"], json!("ours text"));
        assert_eq!(merged[0].props["summary_of_hash"], json!("h_ours"));

        // Determinism: merging again yields an identical record.
        assert_eq!(merged, merge_nodes(&base, &ours, &theirs));
    }

    /// Companion to the above: both sides change structure to different hashes,
    /// and *both* summaries are stamped to a hash that is NOT the merged hash
    /// (h_ours). Neither qualifies → the summary is dropped (regenerated JIT),
    /// structure = ours.
    #[test]
    fn structure_both_diverge_but_both_summaries_stale_drops_summary() {
        let base = vec![func(ID, "h_base")];
        // Merged hash will be h_ours; both summaries stamped to a stale hash so
        // neither qualifies. (Note: stamping theirs to h_ours would let it graft
        // even though theirs lost the structural pick — see the test below.)
        let ours = vec![with_summary(func(ID, "h_ours"), "ours text", "h_stale")];
        let theirs = vec![with_summary(func(ID, "h_theirs"), "theirs text", "h_stale")];

        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].props["content_hash"], json!("h_ours"));
        assert!(!merged[0].props.contains_key("semantic_summary"));
        assert!(!merged[0].props.contains_key("summary_of_hash"));
        assert_eq!(merged, merge_nodes(&base, &ours, &theirs));
    }

    /// Subtle but intended: the summary graft is keyed purely on
    /// `summary_of_hash == merged_chash`, NOT on which side won the structural
    /// pick. Here ours wins structure (h_ours), ours' OWN summary is stale, but
    /// theirs' summary happens to be stamped to h_ours — so theirs' summary
    /// grafts onto ours' structure. This documents the cross-side graft.
    #[test]
    fn summary_grafts_by_hash_even_from_the_structurally_losing_side() {
        let base = vec![func(ID, "h_base")];
        let ours = vec![with_summary(func(ID, "h_ours"), "ours text", "h_theirs")];
        let theirs = vec![with_summary(func(ID, "h_theirs"), "theirs text", "h_ours")];

        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged.len(), 1);
        // structure: both changed → ours wins.
        assert_eq!(merged[0].props["content_hash"], json!("h_ours"));
        // ours' summary (of h_theirs) is stale; theirs' summary (of h_ours)
        // matches the merged hash → theirs' summary grafts.
        assert_eq!(merged[0].props["semantic_summary"], json!("theirs text"));
        assert_eq!(merged[0].props["summary_of_hash"], json!("h_ours"));
        assert_eq!(merged, merge_nodes(&base, &ours, &theirs));
    }

    /// Both sides change structure identically (same new hash) but write
    /// different summaries against it. Structure = ours (== theirs); summary
    /// pick is deterministic ours.
    #[test]
    fn structure_both_change_identically_summary_pick_is_ours() {
        let base = vec![func(ID, "h_base")];
        let ours = vec![with_summary(func(ID, "h_new"), "ours text", "h_new")];
        let theirs = vec![with_summary(func(ID, "h_new"), "theirs text", "h_new")];

        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged[0].props["content_hash"], json!("h_new"));
        assert_eq!(merged[0].props["semantic_summary"], json!("ours text"));
        assert_eq!(merged, merge_nodes(&base, &ours, &theirs));
    }

    /// Structure unchanged on both sides, but both sides write differing
    /// summaries against the (unchanged) base hash. The `ours == base` branch
    /// does NOT fire here (ours' *summary* differs from base, which has none),
    /// so the deterministic-ours branch applies.
    #[test]
    fn structure_unchanged_both_summaries_diverge_picks_ours() {
        let base = vec![func(ID, "h_base")]; // base has no summary
        let ours = vec![with_summary(func(ID, "h_base"), "ours text", "h_base")];
        let theirs = vec![with_summary(func(ID, "h_base"), "theirs text", "h_base")];

        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged[0].props["content_hash"], json!("h_base"));
        assert_eq!(merged[0].props["semantic_summary"], json!("ours text"));
        assert_eq!(merged, merge_nodes(&base, &ours, &theirs));
    }

    /// The base-summary tie-break branch: ours' summary equals base's summary
    /// (ours did not touch it) while theirs wrote a fresh one → theirs wins.
    /// Structure unchanged on both sides.
    #[test]
    fn ours_summary_equals_base_so_theirs_fresh_write_wins() {
        let base = vec![with_summary(func(ID, "h_base"), "old text", "h_base")];
        let ours = vec![with_summary(func(ID, "h_base"), "old text", "h_base")]; // == base
        let theirs = vec![with_summary(func(ID, "h_base"), "fresh text", "h_base")];

        let merged = merge_nodes(&base, &ours, &theirs);
        assert_eq!(merged[0].props["content_hash"], json!("h_base"));
        assert_eq!(
            merged[0].props["semantic_summary"],
            json!("fresh text"),
            "ours summary == base → theirs is the fresh write and wins"
        );
        assert_eq!(merged, merge_nodes(&base, &ours, &theirs));
    }
}
