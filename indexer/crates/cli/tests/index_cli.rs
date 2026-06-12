use assert_cmd::Command;
use std::fs;
use tempfile::tempdir;

#[test]
fn index_extracts_python_definitions() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("pkg")).unwrap();
    fs::write(
        root.join("pkg/mod.py"),
        b"class A:\n    def run(self):\n        pass\n\ndef helper():\n    return 1\n",
    )
    .unwrap();

    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["index", "--repo-id", "r", "--name", "d"])
        .arg(root)
        .assert()
        .success();

    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(nodes.contains(r#""id":"rs1:r:class:pkg/mod.py#A""#));
    assert!(nodes.contains(r#""id":"rs1:r:func:pkg/mod.py#A.run@1""#));
    assert!(nodes.contains(r#""id":"rs1:r:func:pkg/mod.py#helper@0""#));

    let edges = fs::read_to_string(root.join(".reposkein/edges.jsonl")).unwrap();
    assert!(edges.contains("DEFINES"));
}

#[test]
fn index_writes_canonical_jsonl_with_fixed_repo_id() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/a.py"), b"print(1)\n").unwrap();

    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .arg("index")
        .arg("--repo-id")
        .arg("testrepo")
        .arg("--name")
        .arg("demo")
        .arg(root)
        .assert()
        .success();

    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    let edges = fs::read_to_string(root.join(".reposkein/edges.jsonl")).unwrap();

    assert!(nodes.contains(r#""id":"rs1:testrepo:file:src/a.py""#));
    assert!(nodes.contains(r#""id":"rs1:testrepo:repo:.""#));
    assert!(edges.contains("CONTAINS"));
    assert!(nodes.ends_with('\n'));
    for line in nodes.lines() {
        let _: serde_json::Value = serde_json::from_str(line).expect("each line is valid JSON");
    }
}

#[test]
fn index_is_idempotent_byte_identical() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("a.py"), b"print(1)\n").unwrap();

    let run = || {
        Command::cargo_bin("reposkein-indexer")
            .unwrap()
            .args(["index", "--repo-id", "r", "--name", "d"])
            .arg(root)
            .assert()
            .success();
        fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap()
    };

    assert_eq!(run(), run());
}
