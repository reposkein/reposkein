use assert_cmd::Command;
use std::fs;
use tempfile::tempdir;

#[test]
fn merge_jsonl_infers_kind_from_filename() {
    let dir = tempdir().unwrap();
    let p = |name: &str| dir.path().join(name);
    let e = r#"{"from":"a","type":"CALLS","to":"b"}"#;
    fs::write(p("edges.base"), format!("{e}\n")).unwrap();
    fs::write(p("edges.jsonl"), format!("{e}\n")).unwrap(); // "ours" path contains "edges"
    fs::write(p("edges.theirs"), format!("{e}\n")).unwrap();
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .arg("merge-jsonl") // no --kind
        .arg(p("edges.base"))
        .arg(p("edges.jsonl"))
        .arg(p("edges.theirs"))
        .assert()
        .success();
    let merged = fs::read_to_string(p("edges.jsonl")).unwrap();
    assert!(merged.contains(r#""type":"CALLS""#));
}

#[test]
fn merge_jsonl_unions_independent_summaries() {
    let dir = tempdir().unwrap();
    let p = |name: &str| dir.path().join(name);

    // Two function nodes A and B (base), ours summarizes A, theirs summarizes B.
    let a = r#"{"id":"rs1:r:func:a#f@0","labels":["Function"],"content_hash":"ha","qualified_name":"f"}"#;
    let b = r#"{"id":"rs1:r:func:b#g@0","labels":["Function"],"content_hash":"hb","qualified_name":"g"}"#;
    let a_sum = r#"{"id":"rs1:r:func:a#f@0","labels":["Function"],"content_hash":"ha","qualified_name":"f","semantic_summary":"does A","summary_of_hash":"ha"}"#;
    let b_sum = r#"{"id":"rs1:r:func:b#g@0","labels":["Function"],"content_hash":"hb","qualified_name":"g","semantic_summary":"does B","summary_of_hash":"hb"}"#;

    fs::write(p("base"), format!("{a}\n{b}\n")).unwrap();
    fs::write(p("ours"), format!("{a_sum}\n{b}\n")).unwrap();
    fs::write(p("theirs"), format!("{a}\n{b_sum}\n")).unwrap();

    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["merge-jsonl", "--kind", "nodes"])
        .arg(p("base"))
        .arg(p("ours"))
        .arg(p("theirs"))
        .assert()
        .success();

    let merged = fs::read_to_string(p("ours")).unwrap();
    assert!(merged.contains(r#""semantic_summary":"does A""#));
    assert!(merged.contains(r#""semantic_summary":"does B""#));
    // canonical: sorted, LF-terminated
    assert!(merged.ends_with('\n'));
    assert!(merged.find("a#f").unwrap() < merged.find("b#g").unwrap());
}
