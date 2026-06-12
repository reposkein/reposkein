use assert_cmd::Command;
use std::fs;
use std::process::Command as Proc;
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

#[test]
fn real_git_merge_of_edges_jsonl_via_driver() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let git = |args: &[&str]| {
        Proc::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .unwrap();
    };
    git(&["init", "-q"]);
    git(&["config", "user.email", "t@t.co"]);
    git(&["config", "user.name", "t"]);
    let bin = assert_cmd::cargo::cargo_bin("reposkein-indexer");
    // Register the driver exactly as `init --hooks` does, using %P.
    Proc::new("git")
        .args(["config", "merge.reposkein-jsonl.driver"])
        .arg(format!("{} merge-jsonl --path %P %O %A %B", bin.display()))
        .current_dir(root)
        .status()
        .unwrap();
    fs::create_dir_all(root.join(".reposkein")).unwrap();
    fs::write(
        root.join(".gitattributes"),
        ".reposkein/edges.jsonl merge=reposkein-jsonl\n",
    )
    .unwrap();

    let e = |from: &str| format!("{{\"from\":\"{from}\",\"type\":\"CONTAINS\",\"to\":\"b\"}}\n");
    fs::write(root.join(".reposkein/edges.jsonl"), e("base")).unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-qm", "base"]);

    // Detect the initial branch name (may be "master" or "main")
    let initial_branch = {
        let out = Proc::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    git(&["checkout", "-q", "-b", "feat"]);
    fs::write(
        root.join(".reposkein/edges.jsonl"),
        format!("{}{}", e("base"), e("feat")),
    )
    .unwrap();
    git(&["commit", "-qam", "feat"]);
    git(&["checkout", "-q", &initial_branch]);
    fs::write(
        root.join(".reposkein/edges.jsonl"),
        format!("{}{}", e("base"), e("main")),
    )
    .unwrap();
    git(&["commit", "-qam", "main"]);
    let status = Proc::new("git")
        .args(["merge", "feat", "-m", "m"])
        .current_dir(root)
        .status()
        .unwrap();

    assert!(
        status.success(),
        "driver-backed merge of edges.jsonl must succeed"
    );
    let merged = fs::read_to_string(root.join(".reposkein/edges.jsonl")).unwrap();
    assert!(!merged.contains("<<<<<<<"), "no conflict markers");
    // Both concurrent edges survive (union by key; the driver ran on edges, not as nodes).
    assert!(merged.contains("\"from\":\"feat\""));
    assert!(merged.contains("\"from\":\"main\""));
}
