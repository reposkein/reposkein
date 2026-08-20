//! Sharded authored summaries: the committed half of `.reposkein/`.
//!
//! # Why shards
//!
//! `.reposkein/summaries.jsonl` was one file. Two branches that each teach the
//! agent about a different function both rewrite it, and the forge reports a
//! conflict — the exact failure `docs/migrations/2026-08-06-stop-committing-derived-graph.md`
//! measured for `nodes.jsonl`. A `merge=union` `.gitattributes` line does not
//! rescue it: forges compute mergeability in a **bare** repo, where a
//! tree-level `.gitattributes` is never consulted.
//!
//! So the fix is file granularity, the same one the decision log already uses.
//! A summary lands in `.reposkein/summaries/<xx>.jsonl` where `<xx>` is the
//! first two hex characters of `BLAKE3(node_id)` — 256 shards, each holding
//! ~1/256th of the repo's authored prose. Two branches touching unrelated code
//! land in different shards and never meet; two branches touching the same
//! shard still merge cleanly line-wise most of the time, and when they do
//! collide the tolerant reader below survives it.
//!
//! Hashing the id rather than slicing it matters: `rs1:<repo>:func:...` ids
//! share long prefixes, so a prefix shard would put an entire repo in one file.
//!
//! # Why the Rust indexer is the sole writer
//!
//! Byte-identical output across machines is a CI-enforced invariant. Two
//! serializers (serde_json here, `JSON.stringify` in the MCP server) cannot be
//! held to that indefinitely — they differ on escapes and number formatting.
//! The TypeScript side therefore only ever *reads* committed shards; its own
//! writes go to the git-ignored per-agent sidecar, which this indexer folds in.
//! That is also why nothing here needs a cross-language hash: TS enumerates
//! shard files with `readdir`, it never computes a shard key.

use crate::model::Node;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Directory (under `.reposkein/`) holding the committed shards.
pub const SHARD_DIR: &str = "summaries";
/// The pre-sharding committed file. Read for one release, then migrated away.
pub const LEGACY_FILE: &str = "summaries.jsonl";
/// Git-ignored file preserving records that lost a divergence tiebreak.
pub const CONFLICTS_FILE: &str = "conflicts.jsonl";

/// `<xx>`: the first two hex characters of BLAKE3(node_id).
pub fn shard_key(node_id: &str) -> String {
    blake3::hash(node_id.as_bytes()).to_hex().as_str()[..2].to_string()
}

/// Shard file name for a node id, e.g. `4f.jsonl`.
pub fn shard_file_name(node_id: &str) -> String {
    format!("{}.jsonl", shard_key(node_id))
}

/// True for a file name this module owns inside `.reposkein/summaries/`.
pub fn is_shard_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return false;
    };
    stem.len() == 2
        && stem
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// True for a line git left behind from an unresolved textual merge.
///
/// A canonical summary line always starts with `{`, so any line starting with
/// a marker run is damage, not data. Dropping it (with a warning) is what
/// keeps one bad merge from taking recall down — the same tolerance
/// `loadDecisions` applies to a damaged decision file.
pub fn is_conflict_marker(line: &str) -> bool {
    const MARKERS: [&str; 4] = ["<<<<<<<", "=======", ">>>>>>>", "|||||||"];
    MARKERS.iter().any(|m| line.starts_with(m))
}

/// One authored summary as read from a file, keeping the RAW source line.
///
/// The raw bytes matter: they are the divergence tiebreak, and comparing bytes
/// read from disk (rather than a re-serialization) is the only comparison the
/// Rust indexer and the TypeScript reader can be guaranteed to agree on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryRecord {
    pub id: String,
    pub props: Map<String, Value>,
    /// The line exactly as it appeared in the file (no trailing newline).
    pub line: String,
}

impl SummaryRecord {
    pub fn to_node(&self) -> Node {
        Node {
            id: self.id.clone(),
            labels: Vec::new(),
            props: self.props.clone(),
        }
    }

    fn summary_at(&self) -> &str {
        self.props
            .get("summary_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    }
}

/// Deterministic winner between two records that claim the same node id.
///
/// 1. Newer `summary_at` wins (ISO-8601 sorts lexicographically).
/// 2. Tie → the byte-lexicographically smaller raw line wins.
///
/// Both steps are pure functions of bytes on disk, so every machine — and the
/// TypeScript reader — picks the same winner without coordinating. Rule 2 is
/// arbitrary on purpose: what matters is that the loser is *preserved*, not
/// which side wins. See [`LoadedSummaries::conflicts`].
pub fn beats(candidate: &SummaryRecord, incumbent: &SummaryRecord) -> bool {
    match candidate.summary_at().cmp(incumbent.summary_at()) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => candidate.line.as_bytes() < incumbent.line.as_bytes(),
    }
}

#[derive(Debug, Default, Clone)]
pub struct LoadedSummaries {
    /// Winner per node id, keyed by id (so iteration is sorted).
    pub records: BTreeMap<String, SummaryRecord>,
    /// Records that lost a divergence tiebreak. Never discarded: they are
    /// authored prose, and the whole point of the split is that no re-index
    /// can recover it.
    pub conflicts: Vec<SummaryRecord>,
    /// Human-readable notes about damaged input (conflict markers, bad JSON).
    pub warnings: Vec<String>,
}

impl LoadedSummaries {
    /// Folds one file's text in. `source` names the file in warnings.
    pub fn absorb(&mut self, source: &str, text: &str) {
        let mut markers = 0usize;
        let mut malformed = 0usize;
        for line in text.lines() {
            let trimmed = line.trim_end_matches('\r');
            if trimmed.trim().is_empty() {
                continue;
            }
            if is_conflict_marker(trimmed) {
                markers += 1;
                continue;
            }
            let mut obj: Map<String, Value> = match serde_json::from_str(trimmed) {
                Ok(o) => o,
                Err(_) => {
                    malformed += 1;
                    continue;
                }
            };
            let id = match obj.remove("id") {
                Some(Value::String(s)) if !s.is_empty() => s,
                _ => {
                    malformed += 1;
                    continue;
                }
            };
            let rec = SummaryRecord {
                id: id.clone(),
                props: obj,
                line: trimmed.to_string(),
            };
            match self.records.get(&id) {
                None => {
                    self.records.insert(id, rec);
                }
                Some(existing) => {
                    if existing.line == rec.line {
                        continue; // union-merge duplicate: identical, not a conflict
                    }
                    if beats(&rec, existing) {
                        let loser = self.records.insert(id, rec).expect("checked present");
                        self.conflicts.push(loser);
                    } else {
                        self.conflicts.push(rec);
                    }
                }
            }
        }
        if markers > 0 {
            self.warnings.push(format!(
                "{source}: skipped {markers} git conflict-marker line(s); \
                 re-run `reposkein-indexer index` to rewrite the shard cleanly"
            ));
        }
        if malformed > 0 {
            self.warnings
                .push(format!("{source}: skipped {malformed} malformed line(s)"));
        }
    }

    pub fn nodes(&self) -> Vec<Node> {
        self.records.values().map(|r| r.to_node()).collect()
    }
}

/// Groups authored summary records into shard file contents.
///
/// Returns `shard file name -> file text`. Only non-empty shards appear, lines
/// within a shard are sorted by id, every line is canonical, and the text is
/// LF-terminated including the last line — so re-running the indexer on an
/// unchanged repo produces the same bytes on every machine.
pub fn summaries_to_shards(nodes: &[Node]) -> BTreeMap<String, String> {
    let mut by_id: BTreeMap<&str, &Node> = BTreeMap::new();
    for n in nodes {
        by_id.insert(n.id.as_str(), n);
    }
    let mut shards: BTreeMap<String, String> = BTreeMap::new();
    for (id, node) in by_id {
        let Some(line) = crate::jsonl::summary_line(id, &node.props) else {
            continue;
        };
        let entry = shards.entry(shard_file_name(id)).or_default();
        entry.push_str(&line);
        entry.push('\n');
    }
    shards
}

/// Canonical text for the git-ignored conflicts file: every preserved loser,
/// deduped by exact line and sorted, so repeated indexes converge instead of
/// growing the file without bound.
pub fn conflicts_to_jsonl(existing: &str, losers: &[SummaryRecord]) -> String {
    let mut lines: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for line in existing.lines() {
        let t = line.trim_end_matches('\r');
        if !t.trim().is_empty() && !is_conflict_marker(t) {
            lines.insert(t.to_string());
        }
    }
    for l in losers {
        lines.insert(l.line.clone());
    }
    let mut out = String::new();
    for l in lines {
        out.push_str(&l);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: &str, summary: &str, at: &str) -> Node {
        Node::new(id, "Function")
            .set("semantic_summary", json!(summary))
            .set("summary_at", json!(at))
    }

    #[test]
    fn shard_key_is_two_lowercase_hex_chars() {
        let k = shard_key("rs1:r:func:m.py#f@0");
        assert_eq!(k.len(), 2);
        assert!(k
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    }

    #[test]
    fn shard_key_spreads_ids_that_share_a_long_prefix() {
        // Real ids differ only in their tail. A prefix-slice shard would put
        // every one of these in the same file; hashing must not.
        let keys: std::collections::BTreeSet<String> = (0..64)
            .map(|i| shard_key(&format!("rs1:abcdef012345:func:src/app.py#f{i}@0")))
            .collect();
        assert!(
            keys.len() > 20,
            "hashing should spread near-identical ids across shards, got {} distinct",
            keys.len()
        );
    }

    #[test]
    fn is_shard_file_name_accepts_only_lowercase_two_hex() {
        assert!(is_shard_file_name("00.jsonl"));
        assert!(is_shard_file_name("ff.jsonl"));
        assert!(!is_shard_file_name("FF.jsonl"));
        assert!(!is_shard_file_name("0.jsonl"));
        assert!(!is_shard_file_name("000.jsonl"));
        assert!(!is_shard_file_name("zz.jsonl"));
        assert!(!is_shard_file_name("00.json"));
    }

    #[test]
    fn shards_hold_only_summary_bearing_nodes_sorted_by_id() {
        let a = node("rs1:r:func:a.py#f@0", "does f", "2026-01-01T00:00:00Z");
        let plain = Node::new("rs1:r:file:a.py", "File");
        let shards = summaries_to_shards(&[plain, a.clone()]);
        let all: String = shards.values().cloned().collect();
        assert_eq!(all.lines().count(), 1, "only the summarised node: {all}");
        assert!(all.starts_with(r#"{"id":"rs1:r:func:a.py#f@0","#));
        assert!(all.ends_with('\n'));
    }

    #[test]
    fn every_node_lands_in_the_shard_its_key_names() {
        let nodes: Vec<Node> = (0..40)
            .map(|i| {
                node(
                    &format!("rs1:r:func:m.py#f{i}@0"),
                    "s",
                    "2026-01-01T00:00:00Z",
                )
            })
            .collect();
        let shards = summaries_to_shards(&nodes);
        for (name, text) in &shards {
            for line in text.lines() {
                let id = serde_json::from_str::<Value>(line).unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_string();
                assert_eq!(&shard_file_name(&id), name, "{id} filed under {name}");
            }
        }
        assert_eq!(
            shards.values().map(|t| t.lines().count()).sum::<usize>(),
            40
        );
    }

    #[test]
    fn shard_output_is_byte_identical_across_input_orders() {
        let mut nodes: Vec<Node> = (0..30)
            .map(|i| {
                node(
                    &format!("rs1:r:func:m.py#f{i}@0"),
                    "s",
                    "2026-01-01T00:00:00Z",
                )
            })
            .collect();
        let first = summaries_to_shards(&nodes);
        nodes.reverse();
        let second = summaries_to_shards(&nodes);
        assert_eq!(first, second, "shard bytes must not depend on input order");
    }

    #[test]
    fn absorb_skips_conflict_markers_and_keeps_both_sides() {
        let mut loaded = LoadedSummaries::default();
        loaded.absorb(
            "summaries/aa.jsonl",
            concat!(
                "<<<<<<< HEAD\n",
                r#"{"id":"a","semantic_summary":"ours","summary_at":"2026-01-02T00:00:00Z"}"#,
                "\n",
                "=======\n",
                r#"{"id":"b","semantic_summary":"theirs","summary_at":"2026-01-01T00:00:00Z"}"#,
                "\n",
                ">>>>>>> branch\n",
            ),
        );
        assert_eq!(loaded.records.len(), 2, "both sides' records survive");
        assert!(
            loaded.conflicts.is_empty(),
            "different ids are not a conflict"
        );
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].contains("conflict-marker"));
    }

    #[test]
    fn identical_duplicate_lines_dedupe_without_a_conflict() {
        let line = r#"{"id":"a","semantic_summary":"same","summary_at":"2026-01-01T00:00:00Z"}"#;
        let mut loaded = LoadedSummaries::default();
        loaded.absorb("s", &format!("{line}\n{line}\n"));
        assert_eq!(loaded.records.len(), 1);
        assert!(
            loaded.conflicts.is_empty(),
            "a union merge duplicating an unchanged line is not a conflict"
        );
    }

    #[test]
    fn divergent_records_keep_the_newer_and_preserve_the_loser() {
        let old = r#"{"id":"a","semantic_summary":"old","summary_at":"2026-01-01T00:00:00Z"}"#;
        let new = r#"{"id":"a","semantic_summary":"new","summary_at":"2026-02-01T00:00:00Z"}"#;
        for text in [format!("{old}\n{new}\n"), format!("{new}\n{old}\n")] {
            let mut loaded = LoadedSummaries::default();
            loaded.absorb("s", &text);
            assert_eq!(loaded.records["a"].props["semantic_summary"], json!("new"));
            assert_eq!(
                loaded.conflicts.len(),
                1,
                "the loser is kept, never dropped"
            );
            assert_eq!(loaded.conflicts[0].props["semantic_summary"], json!("old"));
        }
    }

    #[test]
    fn same_timestamp_divergence_falls_back_to_byte_order() {
        let a = r#"{"id":"a","semantic_summary":"aaa","summary_at":"2026-01-01T00:00:00Z"}"#;
        let z = r#"{"id":"a","semantic_summary":"zzz","summary_at":"2026-01-01T00:00:00Z"}"#;
        for text in [format!("{a}\n{z}\n"), format!("{z}\n{a}\n")] {
            let mut loaded = LoadedSummaries::default();
            loaded.absorb("s", &text);
            assert_eq!(
                loaded.records["a"].props["semantic_summary"],
                json!("aaa"),
                "the tiebreak must not depend on which side git wrote first"
            );
        }
    }

    #[test]
    fn conflicts_file_dedupes_and_sorts_and_never_forgets() {
        let rec = SummaryRecord {
            id: "a".into(),
            props: Map::new(),
            line: r#"{"id":"a","semantic_summary":"first loser"}"#.into(),
        };
        let once = conflicts_to_jsonl("", std::slice::from_ref(&rec));
        let twice = conflicts_to_jsonl(&once, std::slice::from_ref(&rec));
        assert_eq!(
            once, twice,
            "re-recording the same loser must not grow the file"
        );
        let with_second = conflicts_to_jsonl(
            &once,
            &[SummaryRecord {
                id: "b".into(),
                props: Map::new(),
                line: r#"{"id":"b","semantic_summary":"second loser"}"#.into(),
            }],
        );
        assert_eq!(
            with_second.lines().count(),
            2,
            "earlier losers are retained"
        );
        assert!(with_second.lines().next().unwrap().contains("first loser"));
    }
}
