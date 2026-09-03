use assert_cmd::cargo::cargo_bin;
use assert_cmd::Command;
use std::fs;
use std::process::Command as Proc;
use tempfile::tempdir;

fn git_repo() -> tempfile::TempDir {
    let dir = tempdir().unwrap();
    Proc::new("git")
        .arg("init")
        .arg("-q")
        .current_dir(dir.path())
        .status()
        .unwrap();
    dir
}

fn run_init(root: &std::path::Path) {
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["init", "--hooks"])
        .arg(root)
        .assert()
        .success();
}

fn git_config(root: &std::path::Path, key: &str) -> String {
    let out = Proc::new("git")
        .args(["config", "--get", key])
        .current_dir(root)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn init_hooks_installs_all_artifacts() {
    let dir = git_repo();
    let root = dir.path();
    run_init(root);

    for hook in ["pre-commit", "post-commit", "post-merge", "post-checkout"] {
        let p = root.join(".git/hooks").join(hook);
        assert!(p.exists(), "{hook} should exist");
        let body = fs::read_to_string(&p).unwrap();
        assert!(
            body.contains("reposkein"),
            "{hook} should reference reposkein"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&p).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "{hook} should be executable");
        }
    }

    // Idempotent.
    run_init(root);
}

#[test]
fn pre_commit_hook_stages_nothing() {
    let dir = git_repo();
    let root = dir.path();
    run_init(root);

    let body = fs::read_to_string(root.join(".git/hooks/pre-commit")).unwrap();
    assert!(
        !body.contains("git add"),
        "the pre-commit hook must not stage anything: the derived JSONL is \
         git-ignored, and authored summaries are staged by hand.\n{body}"
    );
    assert!(
        body.contains("refresh ."),
        "the hook should still refresh the local graph — through the supervisor, \
         which locks so two hook firings cannot index at once"
    );
}

#[test]
fn init_does_not_declare_a_merge_driver() {
    let dir = git_repo();
    let root = dir.path();
    run_init(root);

    assert!(
        !root.join(".gitattributes").exists(),
        "init must not create .gitattributes: nodes.jsonl / edges.jsonl are no \
         longer committed, so there is nothing for a merge driver to resolve"
    );
    assert_eq!(git_config(root, "merge.reposkein-jsonl.driver"), "");
    assert_eq!(git_config(root, "merge.reposkein-jsonl.name"), "");
}

#[test]
fn init_migrates_away_a_legacy_custom_driver_declaration() {
    let dir = git_repo();
    let root = dir.path();
    // A repo initialised by an older RepoSkein: custom driver in .gitattributes
    // and registered in .git/config.
    fs::write(
        root.join(".gitattributes"),
        "*.png binary\n\
         .reposkein/nodes.jsonl merge=reposkein-jsonl\n\
         .reposkein/edges.jsonl merge=reposkein-jsonl\n",
    )
    .unwrap();
    for (k, v) in [
        (
            "merge.reposkein-jsonl.name",
            "RepoSkein canonical JSONL merge",
        ),
        (
            "merge.reposkein-jsonl.driver",
            "reposkein-indexer merge-jsonl",
        ),
    ] {
        Proc::new("git")
            .args(["config", k, v])
            .current_dir(root)
            .status()
            .unwrap();
    }

    run_init(root);

    let attrs = fs::read_to_string(root.join(".gitattributes")).unwrap();
    assert!(
        !attrs.contains("reposkein"),
        "the stale merge declaration should be gone: {attrs}"
    );
    assert!(
        attrs.contains("*.png binary"),
        "unrelated user lines must survive: {attrs}"
    );
    assert_eq!(git_config(root, "merge.reposkein-jsonl.driver"), "");
    assert_eq!(git_config(root, "merge.reposkein-jsonl.name"), "");
}

#[test]
fn init_migrates_away_a_union_merge_declaration() {
    let dir = git_repo();
    let root = dir.path();
    // `merge=union` was the interim fix. It does not survive a forge's
    // mergeability check either (that runs in a bare repo, where tree-level
    // .gitattributes is never consulted), and where it does apply it keeps both
    // sides' lines, duplicating any node id both branches touched.
    fs::write(
        root.join(".gitattributes"),
        ".reposkein/nodes.jsonl merge=union\n.reposkein/edges.jsonl merge=union\n",
    )
    .unwrap();

    run_init(root);

    assert!(
        !root.join(".gitattributes").exists(),
        "a .gitattributes holding only our lines should be removed, not left empty"
    );
}

#[test]
fn init_leaves_a_foreign_gitattributes_byte_identical() {
    let dir = git_repo();
    let root = dir.path();
    let original = "* text=auto\n*.sh eol=lf\n";
    fs::write(root.join(".gitattributes"), original).unwrap();

    run_init(root);

    assert_eq!(
        fs::read_to_string(root.join(".gitattributes")).unwrap(),
        original,
        "init must not touch a .gitattributes it has no lines in"
    );
}

#[test]
fn init_declares_union_for_the_summary_shards_inside_reposkein() {
    // The shards ARE committed, so a local merge of two branches that both
    // wrote summaries wants a resolution. Union is the right one here (the
    // reader dedupes duplicates and preserves divergence losers), and the
    // declaration lives inside .reposkein/ so it never collides with a user
    // rule and `rm -r .reposkein` is a complete uninstall.
    // REP-35: Also declare -diff/linguist-generated for the derived graph
    // (nodes.jsonl, edges.jsonl) for backwards compatibility with pre-0.2.7
    // repos that still track it.
    let dir = git_repo();
    let root = dir.path();
    fs::create_dir_all(root.join(".reposkein")).unwrap();

    run_init(root);

    let attrs = fs::read_to_string(root.join(".reposkein/.gitattributes")).unwrap();
    assert!(
        attrs
            .lines()
            .any(|l| l.trim() == "summaries/*.jsonl merge=union linguist-generated"),
        "expected a union declaration scoped to the shards: {attrs}"
    );
    assert!(
        attrs.contains("nodes.jsonl -diff linguist-generated") && attrs.contains("edges.jsonl -diff linguist-generated"),
        "the derived graph must be declared with -diff/linguist-generated for backwards compatibility (REP-35): {attrs}"
    );
    assert!(
        !root.join(".gitattributes").exists(),
        "still nothing in the user's root .gitattributes"
    );
}

#[test]
fn init_without_a_reposkein_dir_writes_no_attributes_file() {
    // `init --hooks` in a repo that was never indexed should not conjure a
    // .reposkein/ directory as a side effect.
    let dir = git_repo();
    let root = dir.path();

    run_init(root);

    assert!(!root.join(".reposkein").exists());
}

#[test]
fn reinit_adds_post_commit_to_a_repo_that_predates_it() {
    // Simulate a repo set up by an older RepoSkein: reposkein-managed
    // pre-commit/post-merge/post-checkout hooks, but no post-commit at all
    // (it didn't exist yet). Re-running `init --hooks` must add it — no
    // special upgrade logic needed, since write_hook only preserves a hook
    // it finds *without* the marker; an absent file just gets written fresh.
    let dir = git_repo();
    let root = dir.path();
    let hooks_dir = root.join(".git/hooks");
    fs::create_dir_all(&hooks_dir).unwrap();
    fs::write(
        hooks_dir.join("pre-commit"),
        "#!/bin/sh\n# reposkein-managed\nold pre-commit\n",
    )
    .unwrap();
    fs::write(
        hooks_dir.join("post-merge"),
        "#!/bin/sh\n# reposkein-managed\nold post-merge (load-only, no reindex)\n",
    )
    .unwrap();
    assert!(!hooks_dir.join("post-commit").exists());

    run_init(root);

    assert!(
        hooks_dir.join("post-commit").exists(),
        "post-commit should now be installed"
    );
    let post_commit = fs::read_to_string(hooks_dir.join("post-commit")).unwrap();
    assert!(post_commit.contains(".reposkein/local/indexed-at"));
    // The old post-merge (reposkein-managed, so eligible for overwrite) gets
    // upgraded to the new reindex+marker content.
    let post_merge = fs::read_to_string(hooks_dir.join("post-merge")).unwrap();
    assert!(post_merge.contains("refresh . --load"));
    assert!(!post_merge.contains("load-only"));
}

#[test]
fn pre_commit_hook_runs_the_summary_stage_check() {
    let dir = git_repo();
    let root = dir.path();
    run_init(root);

    let body = fs::read_to_string(root.join(".git/hooks/pre-commit")).unwrap();
    assert!(
        body.contains("stage-summaries"),
        "the hook must notice authored shards left out of the commit:\n{body}"
    );
}

#[test]
fn post_commit_hook_only_records_the_marker_no_reindex() {
    let dir = git_repo();
    let root = dir.path();
    run_init(root);

    let body = fs::read_to_string(root.join(".git/hooks/post-commit")).unwrap();
    assert!(
        body.contains(".reposkein/local/indexed-at"),
        "post-commit should record the indexed-at marker:\n{body}"
    );
    assert!(
        body.contains("git rev-parse HEAD"),
        "post-commit should record HEAD (only knowable after the commit exists):\n{body}"
    );
    assert!(
        !body.contains("index ."),
        "post-commit must not reindex — pre-commit already indexed the tree \
         that became this commit:\n{body}"
    );
}

#[test]
fn post_merge_hook_refreshes_through_the_supervisor() {
    let dir = git_repo();
    let root = dir.path();
    run_init(root);

    let body = fs::read_to_string(root.join(".git/hooks/post-merge")).unwrap();
    assert!(
        body.contains("refresh . --load"),
        "post-merge must refresh — a merge/checkout changes the tree without \
         going through the developer's own pre-commit — and it must do so \
         through the supervisor, which holds a lock and folds a burst of \
         checkouts into one pass:\n{body}"
    );
    assert!(
        !body.contains(") &"),
        "and it must not detach the database import: git would hand control \
         back while several importers were still running:\n{body}"
    );
}

fn configure_identity(root: &std::path::Path) {
    for (k, v) in [("user.email", "t@example.com"), ("user.name", "t")] {
        Proc::new("git")
            .args(["config", k, v])
            .current_dir(root)
            .status()
            .unwrap();
    }
}

/// End-to-end: install hooks with the *real* compiled binary wired up via
/// REPOSKEIN_INDEXER_BIN, make a real commit, and confirm the post-commit
/// hook recorded exactly the new HEAD — the false-fail-loop repro this whole
/// hook change closes (pre-commit indexes; without post-commit, nothing ever
/// records that the marker should advance, so `doctor --ci` reads stale
/// after every single commit until someone runs `reposkein-mcp index` by
/// hand).
#[test]
fn post_commit_records_new_head_after_a_real_commit() {
    let dir = git_repo();
    let root = dir.path();
    configure_identity(root);
    run_init(root);

    let bin = cargo_bin("reposkein-indexer");
    fs::write(root.join("a.py"), "def f():\n    return 1\n").unwrap();
    Proc::new("git")
        .args(["add", "a.py"])
        .current_dir(root)
        .status()
        .unwrap();
    let commit_status = Proc::new("git")
        .args(["commit", "-qm", "add a.py"])
        .current_dir(root)
        .env("REPOSKEIN_INDEXER_BIN", &bin)
        .status()
        .unwrap();
    assert!(commit_status.success());

    let head_out = Proc::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .unwrap();
    let head_sha = String::from_utf8_lossy(&head_out.stdout).trim().to_string();
    assert!(!head_sha.is_empty());

    let marker = fs::read_to_string(root.join(".reposkein/local/indexed-at"))
        .expect("post-commit hook should have written the marker");
    assert_eq!(
        marker.trim(),
        head_sha,
        "the marker must name the commit that was just created, not its parent"
    );

    // nodes.jsonl was built by pre-commit against the pre-commit tree — the
    // same tree that became this commit.
    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        nodes.contains("a.py"),
        "pre-commit should have indexed a.py: {nodes}"
    );
}

/// End-to-end: directly invoking the post-merge hook (simulating what git
/// runs after a real `git merge`/`git pull`) reindexes the changed tree AND
/// records the marker — so a merge that lands new code doesn't leave the
/// marker pointing at a graph that predates it.
#[test]
fn post_merge_hook_reindexes_and_records_marker_end_to_end() {
    let dir = git_repo();
    let root = dir.path();
    configure_identity(root);
    run_init(root);
    let bin = cargo_bin("reposkein-indexer");

    fs::write(root.join("a.py"), "def f():\n    return 1\n").unwrap();
    Proc::new("git")
        .args(["add", "a.py"])
        .current_dir(root)
        .status()
        .unwrap();
    Proc::new("git")
        .args(["commit", "-qm", "init"])
        .current_dir(root)
        .env("REPOSKEIN_INDEXER_BIN", &bin)
        .status()
        .unwrap();

    // Simulate new code landing via a merge/checkout that does NOT go
    // through the developer's own pre-commit (e.g. a fast-forward pull).
    fs::write(root.join("b.py"), "def g():\n    return 2\n").unwrap();
    Proc::new("git")
        .args(["add", "b.py"])
        .current_dir(root)
        .status()
        .unwrap();
    Proc::new("git")
        .args([
            "commit",
            "-qm",
            "simulate a merge commit landing b.py",
            "--no-verify",
        ])
        .current_dir(root)
        .status()
        .unwrap();

    let status = Proc::new(root.join(".git/hooks/post-merge"))
        .current_dir(root)
        .env("REPOSKEIN_INDEXER_BIN", &bin)
        .status()
        .unwrap();
    assert!(status.success());

    let nodes = fs::read_to_string(root.join(".reposkein/nodes.jsonl")).unwrap();
    assert!(
        nodes.contains("b.py"),
        "post-merge should have reindexed to include the newly-landed file: {nodes}"
    );

    let head_out = Proc::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .unwrap();
    let head_sha = String::from_utf8_lossy(&head_out.stdout).trim().to_string();
    let marker = fs::read_to_string(root.join(".reposkein/local/indexed-at")).unwrap();
    assert_eq!(marker.trim(), head_sha);
}

/// A stand-in `$BIN` that always fails, regardless of subcommand/args — used
/// to prove the marker is withheld on a failed index rather than written
/// unconditionally (the exact bug this test file's other tests would NOT
/// have caught, since they only exercise the success path).
fn write_failing_binary(root: &std::path::Path) -> std::path::PathBuf {
    let p = root.join("fake-failing-indexer.sh");
    fs::write(&p, "#!/bin/sh\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    }
    p
}

fn head_sha(root: &std::path::Path) -> String {
    let out = Proc::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

#[test]
fn precommit_postcommit_withhold_the_marker_when_the_index_fails() {
    let dir = git_repo();
    let root = dir.path();
    configure_identity(root);
    run_init(root);
    let failing_bin = write_failing_binary(root);

    fs::write(root.join("a.py"), "def f():\n    return 1\n").unwrap();
    Proc::new("git")
        .args(["add", "a.py"])
        .current_dir(root)
        .status()
        .unwrap();
    let commit_status = Proc::new("git")
        .args(["commit", "-qm", "add a.py"])
        .current_dir(root)
        .env("REPOSKEIN_INDEXER_BIN", &failing_bin)
        .status()
        .unwrap();
    // A failed index must not block the commit (pre-existing design: exit 0
    // either way) — only the marker write is gated.
    assert!(commit_status.success());

    assert!(
        !root.join(".reposkein/local/indexed-at").exists(),
        "the indexed-at marker must not be written when pre-commit's index failed"
    );
    assert!(
        !root.join(".reposkein/local/.precommit-indexed-ok").exists(),
        "the transient success flag must not survive a failed index (nothing to consume)"
    );
}

#[test]
fn precommit_postcommit_do_not_advance_a_marker_left_by_an_earlier_successful_commit() {
    // Same as above, but starting from a repo that already has a real,
    // correctly-recorded marker (from a prior successful commit) — proves a
    // later *failed* index doesn't advance it to the new (unindexed) HEAD.
    let dir = git_repo();
    let root = dir.path();
    configure_identity(root);
    run_init(root);
    let real_bin = cargo_bin("reposkein-indexer");

    fs::write(root.join("a.py"), "def f():\n    return 1\n").unwrap();
    Proc::new("git")
        .args(["add", "a.py"])
        .current_dir(root)
        .status()
        .unwrap();
    Proc::new("git")
        .args(["commit", "-qm", "commit A (indexes successfully)"])
        .current_dir(root)
        .env("REPOSKEIN_INDEXER_BIN", &real_bin)
        .status()
        .unwrap();
    let sha_a = head_sha(root);
    let marker_after_a = fs::read_to_string(root.join(".reposkein/local/indexed-at")).unwrap();
    assert_eq!(marker_after_a.trim(), sha_a);

    let failing_bin = write_failing_binary(root);
    fs::write(root.join("a.py"), "def f():\n    return 2\n").unwrap();
    Proc::new("git")
        .args(["add", "a.py"])
        .current_dir(root)
        .status()
        .unwrap();
    Proc::new("git")
        .args(["commit", "-qm", "commit B (index fails)"])
        .current_dir(root)
        .env("REPOSKEIN_INDEXER_BIN", &failing_bin)
        .status()
        .unwrap();
    let sha_b = head_sha(root);
    assert_ne!(sha_a, sha_b);

    let marker_after_b = fs::read_to_string(root.join(".reposkein/local/indexed-at")).unwrap();
    assert_eq!(
        marker_after_b.trim(),
        sha_a,
        "the marker must stay at the last successfully-indexed commit, not advance to HEAD"
    );
}

#[test]
fn post_merge_hook_withholds_the_marker_when_the_index_fails() {
    let dir = git_repo();
    let root = dir.path();
    configure_identity(root);
    run_init(root);
    let real_bin = cargo_bin("reposkein-indexer");

    fs::write(root.join("a.py"), "def f():\n    return 1\n").unwrap();
    Proc::new("git")
        .args(["add", "a.py"])
        .current_dir(root)
        .status()
        .unwrap();
    Proc::new("git")
        .args(["commit", "-qm", "init"])
        .current_dir(root)
        .env("REPOSKEIN_INDEXER_BIN", &real_bin)
        .status()
        .unwrap();
    let sha_a = head_sha(root);
    let marker_after_a = fs::read_to_string(root.join(".reposkein/local/indexed-at")).unwrap();
    assert_eq!(marker_after_a.trim(), sha_a);

    // Land a second commit as if via merge/pull (skip hooks entirely), then
    // invoke post-merge by hand with a failing $BIN — simulating the
    // reindex itself failing (missing binary handling is already covered
    // by the "indexer not found" early-exit branch; this is the "found but
    // fails" case the fix targets).
    fs::write(root.join("b.py"), "def g():\n    return 2\n").unwrap();
    Proc::new("git")
        .args(["add", "b.py"])
        .current_dir(root)
        .status()
        .unwrap();
    Proc::new("git")
        .args([
            "commit",
            "-qm",
            "simulate a merge commit landing b.py",
            "--no-verify",
        ])
        .current_dir(root)
        .status()
        .unwrap();
    let sha_b = head_sha(root);
    assert_ne!(sha_a, sha_b);

    let failing_bin = write_failing_binary(root);
    let status = Proc::new(root.join(".git/hooks/post-merge"))
        .current_dir(root)
        .env("REPOSKEIN_INDEXER_BIN", &failing_bin)
        .status()
        .unwrap();
    assert!(
        status.success(),
        "post-merge must still exit 0 even when the index fails"
    );

    let marker_after_failed_merge =
        fs::read_to_string(root.join(".reposkein/local/indexed-at")).unwrap();
    assert_eq!(
        marker_after_failed_merge.trim(),
        sha_a,
        "a failed post-merge index must not advance the marker to the new (unindexed) HEAD"
    );
}
