//! Cross-language contract for the sharded summary store.
//!
//! The vectors in `fixtures/summary-shard-vectors.json` are asserted here AND
//! in `mcp/test/summaryShards.test.ts`. The Rust indexer is the only writer of
//! committed shards, but the TypeScript MCP server reads them, and the two must
//! resolve a merged shard to the same winner — otherwise the server serves
//! prose the next index is about to replace. A change to either implementation
//! that drifts from the other fails one of these two suites.

use reposkein_core::summaries::LoadedSummaries;
use serde_json::Value;
use std::collections::BTreeMap;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../fixtures/summary-shard-vectors.json"
    );
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!("the shared cross-language fixture must be readable at {path}: {e}")
    });
    serde_json::from_str(&text).expect("fixture must be valid JSON")
}

#[test]
fn shard_keys_match_the_shared_vectors() {
    // The committed layout is a public artifact: changing the hash moves every
    // repo's summaries to different files and re-conflicts every open branch.
    let v = vectors();
    let cases = v["shard_key"]["vectors"].as_array().unwrap();
    assert!(!cases.is_empty(), "fixture must carry shard-key vectors");
    for case in cases {
        let id = case["node_id"].as_str().unwrap();
        let want = case["shard"].as_str().unwrap();
        assert_eq!(
            reposkein_core::summaries::shard_key(id),
            want,
            "shard key for {id:?}"
        );
        assert_eq!(
            reposkein_core::summaries::shard_file_name(id),
            format!("{want}.jsonl")
        );
    }
}

/// Total lines the loader reported skipping, read back out of its warnings.
fn skipped_count(loaded: &LoadedSummaries) -> u64 {
    loaded
        .warnings
        .iter()
        .filter_map(|w| w.split_whitespace().find_map(|t| t.parse::<u64>().ok()))
        .sum()
}

fn source_from(lines: &Value) -> LoadedSummaries {
    let text: String = lines
        .as_array()
        .unwrap()
        .iter()
        .map(|l| format!("{}\n", l.as_str().unwrap()))
        .collect();
    let mut loaded = LoadedSummaries::default();
    loaded.absorb("fixture", &text);
    loaded
}

/// Winners and (sorted) conflicts of a folded accumulator, ready to compare
/// against a fixture case. Conflict ORDER is an implementation detail;
/// membership is the contract, so both suites compare sorted.
fn outcome(loaded: &LoadedSummaries) -> (BTreeMap<String, String>, Vec<String>) {
    let winners = loaded
        .records
        .iter()
        .map(|(id, r)| (id.clone(), r.line.clone()))
        .collect();
    let mut conflicts: Vec<String> = loaded.conflicts.iter().map(|c| c.line.clone()).collect();
    conflicts.sort();
    (winners, conflicts)
}

fn expected(case: &Value) -> (BTreeMap<String, String>, Vec<String>) {
    let winners = case["winners"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, l)| (id.clone(), l.as_str().unwrap().to_string()))
        .collect();
    let mut conflicts: Vec<String> = case["conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().to_string())
        .collect();
    conflicts.sort();
    (winners, conflicts)
}

#[test]
fn dedupe_matches_the_shared_vectors() {
    let v = vectors();
    let cases = v["dedupe"]["cases"].as_array().unwrap();
    assert!(!cases.is_empty(), "fixture must carry dedupe cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let loaded = source_from(&case["lines"]);
        assert_eq!(outcome(&loaded), expected(case), "[{name}]");
        assert_eq!(
            skipped_count(&loaded),
            case["skipped"].as_u64().unwrap(),
            "[{name}] skipped lines reported"
        );
    }
}

/// The cross-source rule, pinned in both languages exactly as `beats` is.
///
/// This is where the silent loss lived: an unconditional last-source-wins
/// insert let a stale local sidecar overwrite a teammate's newer committed
/// summary with nothing recorded anywhere. It needs the same single shared
/// artifact, or the two implementations can drift on the rule that matters
/// most.
#[test]
fn supersedes_matches_the_shared_vectors() {
    let v = vectors();
    let cases = v["supersedes"]["cases"].as_array().unwrap();
    assert!(!cases.is_empty(), "fixture must carry cross-source cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut older = source_from(&case["older_source"]);
        older.absorb_source(source_from(&case["newer_source"]));

        assert_eq!(outcome(&older), expected(case), "[{name}]");
        assert_eq!(
            skipped_count(&older),
            case["skipped"].as_u64().unwrap(),
            "[{name}] skipped lines reported"
        );
    }
}

/// The two rules must actually disagree somewhere, or pinning both proves
/// nothing. Guards against a future "simplification" that collapses them.
#[test]
fn the_two_rules_are_pinned_to_disagree_on_an_equal_timestamp() {
    let v = vectors();
    let cases = v["supersedes"]["cases"].as_array().unwrap();
    let find = |needle: &str| {
        cases
            .iter()
            .find(|c| c["name"].as_str().unwrap().contains(needle))
            .unwrap_or_else(|| panic!("fixture must carry the {needle:?} case"))
    };
    assert_ne!(
        find("equal summary_at")["winners"]["a"],
        find("inside one source")["winners"]["a"],
        "the cross-source and within-source rules must resolve the SAME tie \
         differently - otherwise one of them is dead weight"
    );
}
