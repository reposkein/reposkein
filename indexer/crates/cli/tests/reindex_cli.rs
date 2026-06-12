use assert_cmd::Command;
use std::fs;
use tempfile::tempdir;

#[test]
fn reindex_reflects_an_edited_file_and_emits_json() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();

    // Initial index.
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["index", "--repo-id", "r", "--name", "d"])
        .arg(root)
        .assert()
        .success();

    // Edit the file, then reindex --file.
    fs::write(
        root.join("m.py"),
        b"def f():\n    return 2\n\ndef g():\n    return 3\n",
    )
    .unwrap();
    let out = Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args([
            "reindex",
            "--repo-id",
            "r",
            "--name",
            "d",
            "--file",
            "m.py",
            "--json",
        ])
        .arg(root)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();

    // Output is valid JSON stats.
    let stats: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert!(stats["nodes"].as_u64().unwrap() > 0);
    assert_eq!(stats["repo_id"], "r");

    // The committed graph reflects the new function g.
    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        nodes.contains(":func:m.py#g@0"),
        "reindex picked up the new function g"
    );
}

#[test]
fn reindex_without_file_arg_works() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["index", "--repo-id", "r"])
        .arg(root)
        .assert()
        .success();
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["reindex", "--repo-id", "r"])
        .arg(root)
        .assert()
        .success();
}
