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

#[test]
fn dedupe_matches_the_shared_vectors() {
    let v = vectors();
    let cases = v["dedupe"]["cases"].as_array().unwrap();
    assert!(!cases.is_empty(), "fixture must carry dedupe cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let text: String = case["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| format!("{}\n", l.as_str().unwrap()))
            .collect();

        let mut loaded = LoadedSummaries::default();
        loaded.absorb("fixture", &text);

        let want_winners = case["winners"].as_object().unwrap();
        let got_winners: std::collections::BTreeMap<String, String> = loaded
            .records
            .iter()
            .map(|(id, r)| (id.clone(), r.line.clone()))
            .collect();
        assert_eq!(
            got_winners.len(),
            want_winners.len(),
            "[{name}] winner count"
        );
        for (id, line) in want_winners {
            assert_eq!(
                got_winners.get(id).map(String::as_str),
                line.as_str(),
                "[{name}] winner for id {id}"
            );
        }

        // Conflict ORDER is an implementation detail; membership is the
        // contract, so both suites compare sorted.
        let mut got_conflicts: Vec<String> =
            loaded.conflicts.iter().map(|c| c.line.clone()).collect();
        got_conflicts.sort();
        let mut want_conflicts: Vec<String> = case["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap().to_string())
            .collect();
        want_conflicts.sort();
        assert_eq!(got_conflicts, want_conflicts, "[{name}] preserved losers");

        let skipped: u64 = loaded
            .warnings
            .iter()
            .filter_map(|w| w.split_whitespace().find_map(|t| t.parse::<u64>().ok()))
            .sum();
        assert_eq!(
            skipped,
            case["skipped"].as_u64().unwrap(),
            "[{name}] skipped lines reported"
        );
    }
}
