//! The committed-artifact contract: `.reposkein/nodes.jsonl` and `edges.jsonl`
//! are derived and git-ignored; `.reposkein/summaries.jsonl` holds the authored
//! half and is the only part of the directory meant to be committed.

use assert_cmd::Command;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

fn index(root: &Path) {
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["index", "--repo-id", "r", "--name", "d"])
        .arg(root)
        .assert()
        .success();
}

fn seed(root: &Path) {
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();
}

const FUNC_ID: &str = "rs1:r:func:m.py#f@0";

fn content_hash(root: &Path, id: &str) -> String {
    let text = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    text.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find(|v| v["id"] == id)
        .and_then(|v| v["content_hash"].as_str().map(String::from))
        .expect("content_hash for the seeded function")
}

/// Writes a sidecar summary the way `write_semantic_summary` does in JSONL mode.
fn write_sidecar(root: &Path, id: &str, summary: &str, hash: &str) {
    let sidecar = root.join(".reposkein/local/summaries.jsonl");
    fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    fs::write(
        &sidecar,
        format!(
            "{{\"id\":\"{id}\",\"semantic_summary\":\"{summary}\",\"summary_of_hash\":\"{hash}\"}}\n"
        ),
    )
    .unwrap();
}

fn summaries(root: &Path) -> Option<String> {
    fs::read_to_string(root.join(".reposkein/summaries.jsonl")).ok()
}

#[test]
fn derived_jsonl_is_gitignored() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);

    let ignore = fs::read_to_string(root.join(".reposkein/.gitignore")).unwrap();
    for entry in ["local/", "nodes.jsonl", "edges.jsonl"] {
        assert!(
            ignore.lines().any(|l| l.trim() == entry),
            "`{entry}` should be git-ignored, got:\n{ignore}"
        );
    }
    assert!(
        !ignore.lines().any(|l| l.trim() == "summaries.jsonl"),
        "summaries.jsonl is authored and must stay committable:\n{ignore}"
    );
}

#[test]
fn a_repo_with_no_summaries_gets_no_summaries_file() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);

    assert!(
        summaries(root).is_none(),
        "nothing authored yet, so nothing to commit"
    );
}

#[test]
fn sidecar_summary_is_persisted_for_committing() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "returns one", &hash);

    index(root);

    let s = summaries(root).expect("summaries.jsonl should exist once one is written");
    assert!(s.contains(FUNC_ID), "should key by node id: {s}");
    assert!(s.contains("returns one"), "should carry the prose: {s}");
    // Authored fields only: no structural payload rides along, which is what
    // keeps this file small and conflict-free.
    for structural in ["content_hash", "labels", "\"path\"", "start_line"] {
        assert!(
            !s.contains(structural),
            "summaries.jsonl must hold no derived fields, found {structural}: {s}"
        );
    }
}

#[test]
fn summaries_file_is_deterministic_across_runs() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "returns one", &hash);

    index(root);
    let first = summaries(root).unwrap();
    index(root);
    let second = summaries(root).unwrap();

    assert_eq!(first, second, "repeated indexes must be byte-identical");
}

#[test]
fn a_summary_survives_the_source_changing_under_it() {
    // The point of splitting authored from derived. `nodes.jsonl` drops a
    // summary whose hash no longer matches, so a stale summary never reads as
    // current. The committed file keeps it: it is stale, not wrong, and
    // deleting it would silently destroy authored prose on the next unrelated
    // refactor (and churn a committed file on every edit).
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "returns one", &hash);
    index(root);

    fs::write(root.join("m.py"), b"def f():\n    return 2\n").unwrap();
    index(root);

    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        !nodes.contains("returns one"),
        "a stale summary must not be served as current"
    );
    let s = summaries(root).expect("the authored summary must be retained");
    assert!(
        s.contains("returns one"),
        "authored prose must survive a source edit: {s}"
    );
}

#[test]
fn a_fresh_clone_rebuilds_the_graph_from_the_committed_summaries_alone() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "returns one", &hash);
    index(root);

    // What a teammate actually checks out: source + the committed summaries,
    // with no derived JSONL and no sidecar.
    fs::remove_file(root.join(".reposkein/nodes.jsonl")).unwrap();
    fs::remove_file(root.join(".reposkein/edges.jsonl")).unwrap();
    assert!(!root.join(".reposkein/local/summaries.jsonl").exists());

    index(root);

    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        nodes.contains("returns one"),
        "the committed summaries file alone must restore the summary: {nodes}"
    );
}

#[test]
fn a_summary_for_deleted_code_is_dropped() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "returns one", &hash);
    index(root);
    assert!(summaries(root).is_some());

    fs::remove_file(root.join("m.py")).unwrap();
    index(root);

    assert!(
        summaries(root).is_none(),
        "the node is gone, so its summary should go with it"
    );
}

#[test]
fn summaries_in_a_legacy_committed_nodes_jsonl_are_harvested() {
    // Migration: repos indexed by an older RepoSkein carry their summaries
    // inside a committed nodes.jsonl. The first index after upgrading must move
    // them into summaries.jsonl rather than stranding them in an ignored file.
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);

    let nodes_path = root.join(".reposkein/nodes.jsonl");
    let text = fs::read_to_string(&nodes_path).unwrap();
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let mut v: serde_json::Value = serde_json::from_str(line).unwrap();
        if v["id"] == FUNC_ID {
            let hash = v["content_hash"].as_str().unwrap().to_string();
            v["semantic_summary"] = serde_json::json!("legacy prose");
            v["summary_of_hash"] = serde_json::json!(hash);
        }
        lines.push(serde_json::to_string(&v).unwrap());
    }
    fs::write(&nodes_path, lines.join("\n") + "\n").unwrap();

    index(root);

    let s = summaries(root).expect("legacy summaries must be harvested");
    assert!(
        s.contains("legacy prose"),
        "a summary living only in nodes.jsonl must be migrated: {s}"
    );
}

#[test]
fn a_corrupt_derived_nodes_file_does_not_abort_the_index() {
    // nodes.jsonl is derived and git-ignored, so a truncated or half-merged one
    // is a normal state to recover from, never a reason to fail.
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    fs::write(root.join(".reposkein/nodes.jsonl"), b"{not json at all\n").unwrap();

    index(root);

    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        nodes.contains(FUNC_ID),
        "the graph should be rebuilt: {nodes}"
    );
}
