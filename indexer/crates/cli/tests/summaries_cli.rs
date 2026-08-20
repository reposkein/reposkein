//! The committed-artifact contract: `.reposkein/nodes.jsonl` and `edges.jsonl`
//! are derived and git-ignored; `.reposkein/summaries/<xx>.jsonl` holds the
//! authored half and is the only part of the directory meant to be committed.

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
    write_sidecar_named(root, "summaries-agent.jsonl", id, summary, hash);
}

fn write_sidecar_named(root: &Path, file: &str, id: &str, summary: &str, hash: &str) {
    let sidecar = root.join(".reposkein/local").join(file);
    fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    fs::write(
        &sidecar,
        format!(
            "{{\"id\":\"{id}\",\"semantic_summary\":\"{summary}\",\"summary_of_hash\":\"{hash}\"}}\n"
        ),
    )
    .unwrap();
}

/// Every shard file name present, sorted.
fn shard_names(root: &Path) -> Vec<String> {
    let dir = root.join(".reposkein/summaries");
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

/// The whole authored corpus: every shard concatenated in file-name order.
/// None when the repo has no shards at all, which is what "nothing authored
/// yet, so nothing to commit" looks like on disk.
fn summaries(root: &Path) -> Option<String> {
    let dir = root.join(".reposkein/summaries");
    let names = shard_names(root);
    if names.is_empty() {
        return None;
    }
    let mut out = String::new();
    for n in names {
        out.push_str(&fs::read_to_string(dir.join(n)).unwrap());
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[test]
fn derived_jsonl_is_gitignored() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);

    let ignore = fs::read_to_string(root.join(".reposkein/.gitignore")).unwrap();
    for entry in ["local/", "nodes.jsonl", "edges.jsonl", "summaries/.*"] {
        assert!(
            ignore.lines().any(|l| l.trim() == entry),
            "`{entry}` should be git-ignored, got:\n{ignore}"
        );
    }
    for authored in ["summaries.jsonl", "summaries/", "summaries/*"] {
        assert!(
            !ignore.lines().any(|l| l.trim() == authored),
            "authored summaries must stay committable, found `{authored}`:\n{ignore}"
        );
    }
}

#[test]
fn shards_carry_a_union_merge_declaration_scoped_to_reposkein() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);

    let attrs = fs::read_to_string(root.join(".reposkein/.gitattributes")).unwrap();
    assert!(
        attrs
            .lines()
            .any(|l| l.trim() == "summaries/*.jsonl merge=union"),
        "shards should declare union for LOCAL merges: {attrs}"
    );
    assert!(
        !root.join(".gitattributes").exists(),
        "the declaration belongs inside .reposkein/, never in the user's root file"
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
    assert!(
        !root.join(".reposkein/summaries").exists(),
        "not even an empty directory should be left behind"
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

    let s = summaries(root).expect("a shard should exist once a summary is written");
    assert!(s.contains(FUNC_ID), "should key by node id: {s}");
    assert!(s.contains("returns one"), "should carry the prose: {s}");
    // Authored fields only: no structural payload rides along, which is what
    // keeps these files small and conflict-free.
    for structural in ["content_hash", "labels", "\"path\"", "start_line"] {
        assert!(
            !s.contains(structural),
            "a shard must hold no derived fields, found {structural}: {s}"
        );
    }
}

#[test]
fn a_summary_lands_in_exactly_one_shard_named_for_its_id() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "returns one", &hash);
    index(root);

    let names = shard_names(root);
    assert_eq!(names.len(), 1, "one summary, one shard: {names:?}");
    let name = &names[0];
    assert_eq!(name.len(), "xx.jsonl".len(), "shard name is <xx>.jsonl");
    assert!(
        name.ends_with(".jsonl") && name[..2].bytes().all(|b| b.is_ascii_hexdigit()),
        "shard name should be two lowercase hex chars: {name}"
    );
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
    let first_names = shard_names(root);
    index(root);
    let second = summaries(root).unwrap();

    assert_eq!(first, second, "repeated indexes must be byte-identical");
    assert_eq!(
        first_names,
        shard_names(root),
        "shard layout must be stable"
    );
}

/// The CI determinism gate, extended to the shards: an index of the same tree
/// in a DIFFERENT directory (different absolute paths, different tempdir name)
/// must produce the same shard files with the same bytes. Absolute paths are
/// the classic way machine-dependence leaks into a "deterministic" artifact.
#[test]
fn shards_are_byte_identical_across_two_checkouts() {
    let make = || {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        seed(&root);
        index(&root);
        let hash = content_hash(&root, FUNC_ID);
        write_sidecar(&root, FUNC_ID, "returns one", &hash);
        index(&root);
        (shard_names(&root), summaries(&root).unwrap(), dir)
    };
    let (names_a, text_a, _keep_a) = make();
    let (names_b, text_b, _keep_b) = make();
    assert_eq!(
        names_a, names_b,
        "shard file names must match across checkouts"
    );
    assert_eq!(text_a, text_b, "shard bytes must match across checkouts");
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

    // What a teammate actually checks out: source + the committed shards,
    // with no derived JSONL and no sidecar.
    fs::remove_file(root.join(".reposkein/nodes.jsonl")).unwrap();
    fs::remove_file(root.join(".reposkein/edges.jsonl")).unwrap();
    assert!(!root.join(".reposkein/local/summaries-agent.jsonl").exists());

    index(root);

    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        nodes.contains("returns one"),
        "the committed shards alone must restore the summary: {nodes}"
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
    // them into the shards rather than stranding them in an ignored file.
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
    // Complete the pre-upgrade picture: an old indexer wrote no local/ dir and
    // no shards, so neither exists yet. (Without this the run above has already
    // closed the one-shot harvest, and we would be testing the steady state.)
    fs::remove_dir_all(root.join(".reposkein/local")).unwrap();

    index(root);

    let s = summaries(root).expect("legacy summaries must be harvested");
    assert!(
        s.contains("legacy prose"),
        "a summary living only in nodes.jsonl must be migrated: {s}"
    );
}

#[test]
fn the_nodes_jsonl_harvest_is_one_shot_per_checkout() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);

    let marker = root.join(".reposkein/local/.legacy-nodes-harvested");
    assert!(
        marker.exists(),
        "the first index must close the migration so later runs skip it"
    );

    // Now plant a summary in nodes.jsonl the way an old indexer would have.
    // The migration is already done for this checkout, so it must be ignored:
    // nodes.jsonl is derived and git-ignored, and treating it as an authored
    // source forever is what leaks prose between branches.
    let nodes_path = root.join(".reposkein/nodes.jsonl");
    let text = fs::read_to_string(&nodes_path).unwrap();
    let patched: Vec<String> = text
        .lines()
        .map(|line| {
            let mut v: serde_json::Value = serde_json::from_str(line).unwrap();
            if v["id"] == FUNC_ID {
                let hash = v["content_hash"].as_str().unwrap().to_string();
                v["semantic_summary"] = serde_json::json!("should not be harvested");
                v["summary_of_hash"] = serde_json::json!(hash);
            }
            serde_json::to_string(&v).unwrap()
        })
        .collect();
    fs::write(&nodes_path, patched.join("\n") + "\n").unwrap();

    index(root);

    assert!(
        summaries(root).is_none(),
        "a post-migration index must not mine nodes.jsonl for authored prose"
    );
}

/// The regression this gate exists for.
///
/// nodes.jsonl is git-ignored, so it survives `git checkout`. When the harvest
/// ran on every index, a summary written on branch A was read back out of that
/// surviving file on branch B and written into BRANCH B's committed shards — so
/// every branch on the machine accumulated every summary ever written there,
/// and each one showed up as a shard diff against every other branch. That is
/// exactly the cross-branch churn the sharding exists to remove.
#[test]
fn a_summary_written_on_one_branch_does_not_leak_into_another_via_nodes_jsonl() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);

    // Branch A: an agent writes a summary and it lands in a committed shard.
    write_sidecar(root, FUNC_ID, "branch A prose", &hash);
    index(root);
    let a_shards = shard_names(root);
    assert!(
        summaries(root).unwrap().contains("branch A prose"),
        "branch A should have committed its summary"
    );

    // Switch to branch B. `git checkout` removes branch A's COMMITTED shards
    // (branch B never had them) and leaves the git-ignored nodes.jsonl —
    // which still carries branch A's grafted summary — exactly in place.
    fs::remove_dir_all(root.join(".reposkein/summaries")).unwrap();
    assert!(
        fs::read_to_string(root.join(".reposkein/nodes.jsonl"))
            .unwrap()
            .contains("branch A prose"),
        "precondition: the ignored graph still holds branch A's prose"
    );

    index(root);

    assert!(
        summaries(root).is_none(),
        "branch B committed no summaries, so it must produce no shards; got {:?} \
         (branch A had {a_shards:?})",
        shard_names(root)
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

// ---------------------------------------------------------------------------
// Migration off the single committed file
// ---------------------------------------------------------------------------

#[test]
fn a_legacy_committed_summaries_file_is_claimed_into_shards() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);

    // What an upgrading repo has on disk: one committed summaries.jsonl and no
    // summaries/ directory.
    let legacy = root.join(".reposkein/summaries.jsonl");
    fs::write(
        &legacy,
        format!(
            "{{\"id\":\"{FUNC_ID}\",\"semantic_summary\":\"legacy prose\",\"summary_of_hash\":\"{hash}\"}}\n"
        ),
    )
    .unwrap();

    index(root);

    assert!(
        !legacy.exists(),
        "the pre-sharding file is retired by the migration, not left to rot"
    );
    let s = summaries(root).expect("its records must survive as shards");
    assert!(
        s.contains("legacy prose"),
        "prose must be carried over: {s}"
    );
    assert!(s.contains(FUNC_ID), "and stay keyed to the same node: {s}");
}

#[test]
fn a_teammate_on_the_old_indexer_recreating_the_legacy_file_loses_nothing() {
    // Dual-read, for one release: an old indexer on someone else's machine
    // writes summaries.jsonl again, and their commit brings it back. The next
    // index here must fold it in rather than ignore it.
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "from the shards", &hash);
    index(root);
    assert!(summaries(root).unwrap().contains("from the shards"));

    fs::write(
        root.join(".reposkein/summaries.jsonl"),
        format!(
            "{{\"id\":\"{FUNC_ID}\",\"semantic_summary\":\"from an old client\",\
              \"summary_of_hash\":\"{hash}\",\"summary_at\":\"2099-01-01T00:00:00Z\"}}\n"
        ),
    )
    .unwrap();

    index(root);

    let s = summaries(root).unwrap();
    assert!(
        s.contains("from an old client"),
        "the newer record from the legacy file must win: {s}"
    );
    assert!(!root.join(".reposkein/summaries.jsonl").exists());
}

#[test]
fn every_per_agent_sidecar_is_folded_in() {
    // Same-machine last-writer-wins was the bug: two agents sharing one
    // local/summaries.jsonl silently overwrote each other. One file per agent
    // fixes the write; this asserts the read side collects all of them.
    let dir = tempdir().unwrap();
    let root = dir.path();
    fs::write(
        root.join("m.py"),
        b"def f():\n    return 1\n\n\ndef g():\n    return 2\n",
    )
    .unwrap();
    index(root);
    let fh = content_hash(root, FUNC_ID);
    let gh = content_hash(root, "rs1:r:func:m.py#g@0");
    write_sidecar_named(root, "summaries-claude.jsonl", FUNC_ID, "by claude", &fh);
    write_sidecar_named(
        root,
        "summaries-codex.jsonl",
        "rs1:r:func:m.py#g@0",
        "by codex",
        &gh,
    );

    index(root);

    let s = summaries(root).expect("both agents' prose must persist");
    assert!(s.contains("by claude"), "{s}");
    assert!(s.contains("by codex"), "{s}");
    assert!(
        fs::read_dir(root.join(".reposkein/local"))
            .unwrap()
            .filter_map(|e| e.ok())
            .all(|e| !e.file_name().to_string_lossy().starts_with("summaries")),
        "consumed sidecars are released, not left to be folded in twice"
    );
}

#[test]
fn a_sidecar_claimed_by_a_crashed_run_is_recovered() {
    // The claim is a hand-off: a run that dies after renaming aside but before
    // writing the shards leaves the file in local/consuming/, and the NEXT run
    // must credit it. Losing it here would lose prose nothing can regenerate.
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);

    let consuming = root.join(".reposkein/local/consuming");
    fs::create_dir_all(&consuming).unwrap();
    fs::write(
        consuming.join("summaries-agent.jsonl"),
        format!(
            "{{\"id\":\"{FUNC_ID}\",\"semantic_summary\":\"orphaned claim\",\"summary_of_hash\":\"{hash}\"}}\n"
        ),
    )
    .unwrap();

    index(root);

    let s = summaries(root).expect("the orphaned claim must be recovered");
    assert!(s.contains("orphaned claim"), "{s}");
    assert!(
        !consuming.join("summaries-agent.jsonl").exists(),
        "and released once it is safely in a shard"
    );
}

// ---------------------------------------------------------------------------
// Two-branch merge: the scenario the whole design exists for
// ---------------------------------------------------------------------------

/// Writes `<xx>.jsonl` directly, the way checking out someone else's branch
/// (or resolving a merge by hand) would leave it.
fn write_shard_raw(root: &Path, name: &str, text: &str) {
    let dir = root.join(".reposkein/summaries");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(name), text).unwrap();
}

fn only_shard_name(root: &Path) -> String {
    let names = shard_names(root);
    assert_eq!(names.len(), 1, "expected exactly one shard: {names:?}");
    names[0].clone()
}

#[test]
fn a_union_merged_shard_with_duplicate_lines_collapses_cleanly() {
    // `merge=union` keeps both sides' lines. Where both branches wrote the SAME
    // record that is a pure duplicate — harmless, and the reader must treat it
    // as one record rather than as a conflict.
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "returns one", &hash);
    index(root);

    let name = only_shard_name(root);
    let line = summaries(root).unwrap();
    write_shard_raw(root, &name, &format!("{line}{line}"));

    index(root);

    let s = summaries(root).unwrap();
    assert_eq!(s.lines().count(), 1, "duplicate lines collapse: {s}");
    assert!(
        !root.join(".reposkein/local/conflicts.jsonl").exists(),
        "an identical duplicate is not a conflict and must not be reported as one"
    );
}

#[test]
fn two_divergent_branches_merged_with_conflict_markers_resolve_deterministically() {
    // The full failure the sharding exists to survive: two branches each wrote
    // a summary for the SAME node, git could not merge the shard, and the
    // working tree now holds conflict markers around both records.
    //
    // Requirements: the index must not fail; the shard must come out canonical
    // and marker-free; the winner must be the same on every machine; and the
    // loser must be preserved somewhere a human can find it.
    let mut resolved: Vec<String> = Vec::new();
    for order in [0, 1] {
        let dir = tempdir().unwrap();
        let root = dir.path();
        seed(root);
        index(root);
        let hash = content_hash(root, FUNC_ID);
        write_sidecar(root, FUNC_ID, "returns one", &hash);
        index(root);
        let name = only_shard_name(root);

        let ours = format!(
            "{{\"id\":\"{FUNC_ID}\",\"semantic_summary\":\"ours: returns the constant 1\",\
              \"summary_at\":\"2026-08-19T10:00:00Z\",\"summary_of_hash\":\"{hash}\"}}"
        );
        let theirs = format!(
            "{{\"id\":\"{FUNC_ID}\",\"semantic_summary\":\"theirs: the identity of one\",\
              \"summary_at\":\"2026-08-20T10:00:00Z\",\"summary_of_hash\":\"{hash}\"}}"
        );
        // Flip which side git wrote first: the resolution must not depend on it.
        let (a, b) = if order == 0 {
            (&ours, &theirs)
        } else {
            (&theirs, &ours)
        };
        write_shard_raw(
            root,
            &name,
            &format!("<<<<<<< HEAD\n{a}\n=======\n{b}\n>>>>>>> feature/other\n"),
        );

        index(root);

        let s = summaries(root).unwrap();
        for marker in ["<<<<<<<", "=======", ">>>>>>>"] {
            assert!(
                !s.contains(marker),
                "the shard must be rewritten clean, found {marker}: {s}"
            );
        }
        assert_eq!(s.lines().count(), 1, "one node, one line: {s}");
        assert!(
            s.contains("theirs: the identity of one"),
            "the newer summary_at must win: {s}"
        );

        let conflicts = fs::read_to_string(root.join(".reposkein/local/conflicts.jsonl"))
            .expect("the losing record is authored prose and must be preserved for a human");
        assert!(
            conflicts.contains("ours: returns the constant 1"),
            "the loser must be recoverable: {conflicts}"
        );
        assert!(
            fs::read_to_string(root.join(".reposkein/nodes.jsonl"))
                .unwrap()
                .contains("theirs: the identity of one"),
            "and the winner must be what the graph serves"
        );
        resolved.push(s);
    }
    assert_eq!(
        resolved[0], resolved[1],
        "the resolution must not depend on which side git wrote first"
    );
}

#[test]
fn two_branches_touching_different_shards_never_meet() {
    // The merge-smoothness claim, stated as a test: summaries for unrelated
    // nodes land in different files, so two branches' commits touch disjoint
    // paths and a forge has nothing to conflict on.
    let dir = tempdir().unwrap();
    let root = dir.path();
    let mut src = String::new();
    for i in 0..24 {
        src.push_str(&format!("def f{i}():\n    return {i}\n\n\n"));
    }
    fs::write(root.join("m.py"), src).unwrap();
    index(root);

    let mut sidecar = String::new();
    for i in 0..24 {
        let id = format!("rs1:r:func:m.py#f{i}@0");
        let h = content_hash(root, &id);
        sidecar.push_str(&format!(
            "{{\"id\":\"{id}\",\"semantic_summary\":\"returns {i}\",\"summary_of_hash\":\"{h}\"}}\n"
        ));
    }
    fs::create_dir_all(root.join(".reposkein/local")).unwrap();
    fs::write(root.join(".reposkein/local/summaries-agent.jsonl"), sidecar).unwrap();

    index(root);

    let names = shard_names(root);
    assert!(
        names.len() >= 12,
        "24 summaries should spread over many shards, got {}: {names:?}",
        names.len()
    );
}

#[test]
fn a_shard_of_pure_garbage_does_not_abort_the_index() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    seed(root);
    index(root);
    let hash = content_hash(root, FUNC_ID);
    write_sidecar(root, FUNC_ID, "returns one", &hash);
    index(root);
    let name = only_shard_name(root);
    write_shard_raw(root, &name, "{not json at all\n\n<<<<<<< HEAD\n");

    index(root);

    // The garbage is gone and the index completed with the graph intact.
    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(nodes.contains(FUNC_ID), "the graph should be rebuilt");
    if let Some(s) = summaries(root) {
        assert!(!s.contains("not json"), "garbage must not persist: {s}");
    }
}
