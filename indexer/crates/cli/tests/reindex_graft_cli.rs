use assert_cmd::Command;
use std::fs;
use tempfile::tempdir;

fn index(root: &std::path::Path) {
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["index", "--repo-id", "r", "--name", "d"])
        .arg(root)
        .assert()
        .success();
}

#[test]
fn summary_survives_reindex_when_source_unchanged() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();
    index(root);

    // Inject a summary onto f, stamped with its current content_hash.
    let nodes_path = root.join(".reposkein/nodes.jsonl");
    let text = fs::read_to_string(&nodes_path).unwrap();
    let mut lines: Vec<String> = Vec::new();
    let mut hash = String::new();
    for line in text.lines() {
        let mut v: serde_json::Value = serde_json::from_str(line).unwrap();
        if v["id"].as_str().unwrap().contains(":func:m.py#f@0") {
            hash = v["content_hash"].as_str().unwrap().to_string();
            v["semantic_summary"] = serde_json::json!("returns one");
            v["summary_of_hash"] = serde_json::json!(hash);
        }
        lines.push(serde_json::to_string(&v).unwrap());
    }
    fs::write(&nodes_path, lines.join("\n") + "\n").unwrap();
    assert!(!hash.is_empty());

    // Reindex without changing the source → summary preserved.
    index(root);
    let after = fs::read_to_string(&nodes_path).unwrap();
    assert!(
        after.contains(r#""semantic_summary":"returns one""#),
        "summary should survive unchanged reindex"
    );

    // Now change the source → content_hash changes → summary dropped.
    fs::write(root.join("m.py"), b"def f():\n    return 2\n").unwrap();
    index(root);
    let changed = fs::read_to_string(&nodes_path).unwrap();
    assert!(
        !changed.contains("returns one"),
        "stale summary should be dropped after source change"
    );
}

#[test]
fn sidecar_summaries_graft_into_committed_jsonl_and_truncate() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();
    index(root);

    // Read f's current content_hash from committed nodes.jsonl.
    let nodes_path = root.join(".reposkein/nodes.jsonl");
    let text = fs::read_to_string(&nodes_path).unwrap();
    let mut hash = String::new();
    let mut id = String::new();
    for line in text.lines() {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        if v["id"].as_str().unwrap().contains(":func:m.py#f@0") {
            hash = v["content_hash"].as_str().unwrap().to_string();
            id = v["id"].as_str().unwrap().to_string();
        }
    }
    assert!(!hash.is_empty());

    // Simulate a JSONL-mode write: a sidecar summary stamped with f's hash.
    let sidecar = root.join(".reposkein/local/summaries.jsonl");
    fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    fs::write(
        &sidecar,
        format!(
            "{{\"id\":\"{id}\",\"semantic_summary\":\"returns one\",\"summary_of_hash\":\"{hash}\"}}\n"
        ),
    )
    .unwrap();

    // Reindex: the sidecar summary should graft into committed nodes.jsonl,
    // and the sidecar should be truncated.
    index(root);
    let after = fs::read_to_string(&nodes_path).unwrap();
    assert!(
        after.contains(r#""semantic_summary":"returns one""#),
        "sidecar summary should graft into committed nodes.jsonl"
    );
    // The sidecar is consumed (renamed aside + removed); no leftover summaries.
    let consumed = !sidecar.exists() || fs::read_to_string(&sidecar).unwrap().trim().is_empty();
    assert!(consumed, "sidecar should be consumed after grafting");
    // The temp claim file must not be left behind.
    assert!(
        !root
            .join(".reposkein/local/summaries.consuming.jsonl")
            .exists(),
        "claim temp file must be cleaned up"
    );
}

#[test]
fn sidecar_written_after_consumption_survives_next_index() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();
    index(root);

    let id = "rs1:r:func:m.py#f@0";
    let hash = {
        let text = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
        text.lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .find(|v| v["id"] == id)
            .and_then(|v| v["content_hash"].as_str().map(String::from))
            .expect("f content_hash")
    };
    let sidecar = root.join(".reposkein/local/summaries.jsonl");
    fs::create_dir_all(sidecar.parent().unwrap()).unwrap();

    // First sidecar summary, consumed by an index.
    fs::write(
        &sidecar,
        format!(
            "{{\"id\":\"{id}\",\"semantic_summary\":\"first\",\"summary_of_hash\":\"{hash}\"}}\n"
        ),
    )
    .unwrap();
    index(root);
    assert!(fs::read_to_string(root.join(".reposkein/nodes.jsonl"))
        .unwrap()
        .contains("\"first\""));

    // A NEW sidecar summary written after consumption must graft on the next index.
    fs::write(
        &sidecar,
        format!(
            "{{\"id\":\"{id}\",\"semantic_summary\":\"second\",\"summary_of_hash\":\"{hash}\"}}\n"
        ),
    )
    .unwrap();
    index(root);
    let after = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        after.contains("\"second\""),
        "post-consumption sidecar write must survive"
    );
}

#[test]
fn stale_sidecar_summary_is_dropped_not_grafted() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();
    index(root);

    let id = "rs1:r:func:m.py#f@0";
    let sidecar = root.join(".reposkein/local/summaries.jsonl");
    fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    // A summary stamped against a hash that does NOT match f's current hash.
    fs::write(
        &sidecar,
        format!("{{\"id\":\"{id}\",\"semantic_summary\":\"stale\",\"summary_of_hash\":\"WRONGHASH\"}}\n"),
    )
    .unwrap();

    index(root);
    let after = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        !after.contains("stale"),
        "a hash-mismatched sidecar summary must not be grafted"
    );
}
