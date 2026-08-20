//! `stage-summaries`: the pre-commit companion that keeps authored prose from
//! being left out of the commit that the session produced it in.
//!
//! Summaries are the one thing under `.reposkein/` no re-index can recover, and
//! an agent writes them mid-session — long after the developer last thought
//! about `git add`. The hook therefore always *notices*, and stages only when
//! the repo opted in.

use assert_cmd::Command;
use std::fs;
use std::path::Path;
use std::process::Command as Proc;
use tempfile::tempdir;

fn git(root: &Path, args: &[&str]) -> String {
    let out = Proc::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn git_repo() -> tempfile::TempDir {
    let dir = tempdir().unwrap();
    let root = dir.path();
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "t@example.com"]);
    git(root, &["config", "user.name", "t"]);
    dir
}

fn index(root: &Path) {
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["index", "--repo-id", "r", "--name", "d"])
        .arg(root)
        .assert()
        .success();
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

/// A repo with source, an index, and one authored summary already sharded.
fn repo_with_a_summary() -> tempfile::TempDir {
    let dir = git_repo();
    let root = dir.path();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();
    index(root);
    let hash = content_hash(root, FUNC_ID);
    fs::create_dir_all(root.join(".reposkein/local")).unwrap();
    fs::write(
        root.join(".reposkein/local/summaries-agent.jsonl"),
        format!(
            "{{\"id\":\"{FUNC_ID}\",\"semantic_summary\":\"returns one\",\"summary_of_hash\":\"{hash}\"}}\n"
        ),
    )
    .unwrap();
    index(root);
    dir
}

fn stage_summaries(root: &Path) -> assert_cmd::assert::Assert {
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["stage-summaries"])
        .arg(root)
        .assert()
        .success()
}

fn set_stage_summaries(root: &Path, value: bool) {
    let cfg = root.join(".reposkein/config.toml");
    let text = fs::read_to_string(&cfg).unwrap();
    // The generated config already carries the key; flip it in place.
    let flipped = text
        .replace(
            "stage_summaries = true",
            &format!("stage_summaries = {value}"),
        )
        .replace(
            "stage_summaries = false",
            &format!("stage_summaries = {value}"),
        );
    fs::write(&cfg, flipped).unwrap();
}

#[test]
fn a_newly_initialized_repo_defaults_to_staging_summaries() {
    let dir = repo_with_a_summary();
    let cfg = fs::read_to_string(dir.path().join(".reposkein/config.toml")).unwrap();
    assert!(
        cfg.lines().any(|l| l.trim() == "stage_summaries = true"),
        "a fresh config should opt in, so the first summary is not silently \
         left out of the commit: {cfg}"
    );
}

#[test]
fn an_existing_config_is_never_rewritten_so_behaviour_does_not_change_underfoot() {
    // The opt-in default applies to NEW repos only. A repo whose config.toml
    // predates the setting keeps hint-only behaviour until someone edits it —
    // an upgrade must not start putting new content into people's commits.
    let dir = git_repo();
    let root = dir.path();
    fs::create_dir_all(root.join(".reposkein")).unwrap();
    let legacy = "schema_version = 1\n\n[languages]\nenabled = [\"python\"]\n";
    fs::write(root.join(".reposkein/config.toml"), legacy).unwrap();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();

    index(root);

    assert_eq!(
        fs::read_to_string(root.join(".reposkein/config.toml")).unwrap(),
        legacy,
        "index must not rewrite an existing config.toml"
    );
}

#[test]
fn opted_in_dirty_shards_are_staged() {
    let dir = repo_with_a_summary();
    let root = dir.path();
    set_stage_summaries(root, true);
    assert!(git(root, &["diff", "--cached", "--name-only"]).is_empty());

    stage_summaries(root);

    let staged = git(root, &["diff", "--cached", "--name-only"]);
    assert!(
        staged
            .lines()
            .any(|l| l.starts_with(".reposkein/summaries/")),
        "the shard should be in the index: {staged:?}"
    );
}

#[test]
fn opted_out_prints_a_hint_and_stages_nothing() {
    let dir = repo_with_a_summary();
    let root = dir.path();
    set_stage_summaries(root, false);

    let out = stage_summaries(root);
    let stderr = String::from_utf8_lossy(&out.get_output().stderr).to_string();

    assert!(
        stderr.contains(".reposkein/summaries"),
        "the hint must name the path to stage: {stderr}"
    );
    assert!(
        stderr.contains("stage_summaries"),
        "and how to make it automatic: {stderr}"
    );
    assert!(
        git(root, &["diff", "--cached", "--name-only"]).is_empty(),
        "opted out means opted out"
    );
}

#[test]
fn a_config_with_no_hooks_section_behaves_as_opted_out() {
    let dir = repo_with_a_summary();
    let root = dir.path();
    fs::write(
        root.join(".reposkein/config.toml"),
        "schema_version = 1\n\n[languages]\nenabled = [\"python\"]\n",
    )
    .unwrap();

    stage_summaries(root);

    assert!(
        git(root, &["diff", "--cached", "--name-only"]).is_empty(),
        "an absent setting must never be read as consent to stage"
    );
}

#[test]
fn clean_shards_produce_no_output_at_all() {
    let dir = repo_with_a_summary();
    let root = dir.path();
    set_stage_summaries(root, false);
    git(root, &["add", "--", ".reposkein/summaries"]);
    git(
        root,
        &["-c", "core.hooksPath=/dev/null", "commit", "-qm", "s"],
    );

    let out = stage_summaries(root);

    assert!(
        String::from_utf8_lossy(&out.get_output().stderr).is_empty(),
        "nothing changed, so the hook must stay silent"
    );
}

#[test]
fn a_shard_already_fully_staged_is_not_reported_again() {
    let dir = repo_with_a_summary();
    let root = dir.path();
    set_stage_summaries(root, false);
    git(root, &["add", "--", ".reposkein/summaries"]);

    let out = stage_summaries(root);

    assert!(
        String::from_utf8_lossy(&out.get_output().stderr).is_empty(),
        "the developer already staged it; a hint here is noise"
    );
}

#[test]
fn outside_a_git_repo_it_is_a_silent_no_op() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(root.join("m.py"), b"def f():\n    return 1\n").unwrap();
    index(root);

    let out = stage_summaries(root);

    assert!(String::from_utf8_lossy(&out.get_output().stderr).is_empty());
}
