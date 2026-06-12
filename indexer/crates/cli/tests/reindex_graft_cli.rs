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
