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

    for hook in ["pre-commit", "post-merge", "post-checkout"] {
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
        body.contains("index ."),
        "the hook should still refresh the local graph"
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
