use assert_cmd::Command;
use std::fs;
use std::process::Command as Proc;
use tempfile::tempdir;

#[test]
fn init_hooks_installs_all_artifacts() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    // Make it a git repo.
    Proc::new("git")
        .arg("init")
        .arg("-q")
        .current_dir(root)
        .status()
        .unwrap();

    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["init", "--hooks"])
        .arg(root)
        .assert()
        .success();

    // Hooks exist and mention reposkein.
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

    // .gitattributes points at the BUILT-IN union strategy, not the custom
    // driver: forges merge server-side without our binary or git config, so a
    // custom driver name there degrades to a plain text merge and conflicts.
    let attrs = fs::read_to_string(root.join(".gitattributes")).unwrap();
    assert!(attrs.contains(".reposkein/nodes.jsonl merge=union"));
    assert!(attrs.contains(".reposkein/edges.jsonl merge=union"));
    assert!(!attrs.contains("merge=reposkein-jsonl"));

    // git config has the merge driver.
    let out = Proc::new("git")
        .args(["config", "merge.reposkein-jsonl.driver"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("merge-jsonl"));

    // Idempotent: running again succeeds and doesn't duplicate gitattributes.
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["init", "--hooks"])
        .arg(root)
        .assert()
        .success();
    let attrs2 = fs::read_to_string(root.join(".gitattributes")).unwrap();
    assert_eq!(attrs2.matches("nodes.jsonl merge=union").count(), 1);
}

/// A repo initialised before the union change still carries the custom-driver
/// line. Leaving it would keep every forge-side merge conflicting, so `init`
/// rewrites it in place rather than appending a second, contradictory rule.
#[test]
fn init_hooks_migrates_legacy_custom_driver_lines() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    Proc::new("git")
        .arg("init")
        .arg("-q")
        .current_dir(root)
        .status()
        .unwrap();

    fs::write(
        root.join(".gitattributes"),
        "*.png binary\n.reposkein/nodes.jsonl merge=reposkein-jsonl\n.reposkein/edges.jsonl merge=reposkein-jsonl\n",
    )
    .unwrap();

    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .args(["init", "--hooks"])
        .arg(root)
        .assert()
        .success();

    let attrs = fs::read_to_string(root.join(".gitattributes")).unwrap();
    assert!(!attrs.contains("merge=reposkein-jsonl"), "legacy line must be rewritten");
    assert_eq!(attrs.matches("nodes.jsonl merge=union").count(), 1);
    assert_eq!(attrs.matches("edges.jsonl merge=union").count(), 1);
    // Unrelated rules are preserved.
    assert!(attrs.contains("*.png binary"));
}
