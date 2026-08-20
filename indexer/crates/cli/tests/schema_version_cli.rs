use assert_cmd::Command;

/// `reposkein-indexer --schema-version` prints the graph schema version and
/// exits 0, without requiring a subcommand or a repo to index. This is the
/// contract the publish-pages.yml CI workflow relies on to assert binary <->
/// .reposkein/meta.json compatibility without depending on the release/package
/// version number, which can drift independently of the schema.
#[test]
fn schema_version_flag_prints_the_schema_version_and_exits_zero() {
    let out = Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .arg("--schema-version")
        .output()
        .unwrap();
    assert!(out.status.success());
    let printed = String::from_utf8(out.stdout).unwrap();
    // A bare integer line — nothing else (no logging noise mixed into stdout).
    assert!(
        printed.trim().chars().all(|c| c.is_ascii_digit()) && !printed.trim().is_empty(),
        "expected a bare integer on stdout, got {printed:?}"
    );
}

/// The value printed must match the constant `reposkein_core::meta` bakes
/// into every `.reposkein/meta.json` — the whole point is that a caller can
/// compare the two without indexing anything.
#[test]
fn schema_version_flag_matches_reposkein_core_meta_schema_version() {
    let out = Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .arg("--schema-version")
        .output()
        .unwrap();
    assert!(out.status.success());
    let printed = String::from_utf8(out.stdout).unwrap().trim().to_string();
    assert_eq!(printed, reposkein_core::meta::SCHEMA_VERSION.to_string());
}

/// No subcommand and no --schema-version: a clear, non-zero-exit error rather
/// than a silent no-op (matches the pre-existing "subcommand required" clap
/// behavior in spirit, now that `command` is `Option<Commands>`).
#[test]
fn missing_subcommand_without_schema_version_flag_fails_clearly() {
    let out = Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .output()
        .unwrap();
    assert!(!out.status.success());
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(
        stderr.contains("missing subcommand"),
        "expected a 'missing subcommand' error, got {stderr:?}"
    );
}

/// --schema-version short-circuits regardless of the (now-optional) subcommand
/// — it must never fall through into "missing subcommand".
#[test]
fn schema_version_flag_takes_priority_and_needs_no_subcommand() {
    Command::cargo_bin("reposkein-indexer")
        .unwrap()
        .arg("--schema-version")
        .assert()
        .success();
}
