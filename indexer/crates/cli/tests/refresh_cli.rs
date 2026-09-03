//! The refresh supervisor: one rebuild at a time, bursts coalesced.
//!
//! `post-checkout` fires on every branch switch, stash and file checkout. It
//! used to run a full blocking index followed by a DETACHED database import,
//! so a few quick switches left several indexers and several importers running
//! at once — each holding its own copy of the graph — after git had already
//! handed control back to the user. These tests pin the two properties that
//! stops: no two refreshes overlap, and a burst becomes one extra pass.

use std::path::Path;
use std::process::Command;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_reposkein-indexer")
}

fn repo(dir: &Path) {
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/a.py"), "def f():\n    return 1\n").unwrap();
    let ok = Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("init")
        .arg("-q")
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    assert!(ok, "git init failed");
}

fn refresh(dir: &Path) -> std::process::Output {
    Command::new(bin())
        .arg("refresh")
        .arg(dir)
        .output()
        .expect("run refresh")
}

fn lock_path(dir: &Path) -> std::path::PathBuf {
    dir.join(".reposkein").join("local").join(".refresh.lock")
}

fn pending_path(dir: &Path) -> std::path::PathBuf {
    dir.join(".reposkein")
        .join("local")
        .join(".refresh-pending")
}

#[test]
fn refresh_builds_the_graph_and_releases_its_lock() {
    let dir = tempfile::tempdir().unwrap();
    repo(dir.path());

    let out = refresh(dir.path());
    assert!(out.status.success(), "refresh failed: {out:?}");

    assert!(dir.path().join(".reposkein/nodes.jsonl").exists());
    assert!(
        !lock_path(dir.path()).exists(),
        "the lock must not outlive the refresh that took it"
    );
}

#[test]
fn a_second_refresh_defers_instead_of_indexing_alongside_the_first() {
    let dir = tempfile::tempdir().unwrap();
    repo(dir.path());

    // Stand in for a refresh already in flight.
    std::fs::create_dir_all(dir.path().join(".reposkein/local")).unwrap();
    std::fs::write(lock_path(dir.path()), "99999\n").unwrap();

    let out = refresh(dir.path());
    assert!(
        out.status.success(),
        "deferring is a normal outcome, not a failure"
    );
    assert!(
        !dir.path().join(".reposkein/nodes.jsonl").exists(),
        "the deferring process must not index alongside the holder"
    );
    assert!(
        pending_path(dir.path()).exists(),
        "it must ask the holder for one more pass"
    );
    assert!(
        lock_path(dir.path()).exists(),
        "and must not release a lock it never took"
    );
}

#[test]
fn a_pending_request_left_by_a_burst_is_consumed_by_the_holder() {
    let dir = tempfile::tempdir().unwrap();
    repo(dir.path());

    // As if three checkouts had piled up while a refresh was starting.
    std::fs::create_dir_all(dir.path().join(".reposkein/local")).unwrap();
    std::fs::write(pending_path(dir.path()), b"").unwrap();

    let out = refresh(dir.path());
    assert!(out.status.success(), "refresh failed: {out:?}");
    assert!(
        !pending_path(dir.path()).exists(),
        "a burst collapses into the holder's pass; the note must not survive it"
    );
    assert!(dir.path().join(".reposkein/nodes.jsonl").exists());
}

#[test]
fn a_lock_left_behind_by_a_dead_process_is_reclaimed() {
    let dir = tempfile::tempdir().unwrap();
    repo(dir.path());
    std::fs::create_dir_all(dir.path().join(".reposkein/local")).unwrap();
    std::fs::write(lock_path(dir.path()), "1\n").unwrap();

    // Backdate past the staleness window: a machine that lost power mid-index
    // must not be locked out of indexing forever.
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60 * 60);
    let f = std::fs::File::options()
        .write(true)
        .open(lock_path(dir.path()))
        .unwrap();
    f.set_modified(old).unwrap();
    drop(f);

    let out = refresh(dir.path());
    assert!(out.status.success(), "refresh failed: {out:?}");
    assert!(
        dir.path().join(".reposkein/nodes.jsonl").exists(),
        "a stale lock must be reclaimed, not obeyed"
    );
    assert!(!lock_path(dir.path()).exists());
}

#[test]
fn the_staleness_marker_records_the_commit_that_was_indexed() {
    let dir = tempfile::tempdir().unwrap();
    repo(dir.path());
    for args in [
        vec!["config", "user.email", "t@example.com"],
        vec!["config", "user.name", "t"],
        vec!["add", "-A"],
        vec!["commit", "-qm", "init"],
    ] {
        Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(&args)
            .status()
            .unwrap();
    }

    assert!(refresh(dir.path()).status.success());

    let head = String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let marker = std::fs::read_to_string(dir.path().join(".reposkein/local/indexed-at")).unwrap();
    assert_eq!(
        marker.trim(),
        head.trim(),
        "doctor --ci's graph_stale check reads this; it must name the commit actually indexed"
    );
}
