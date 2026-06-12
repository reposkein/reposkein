//! Integration tests requiring a running Neo4j. Run with:
//!   NEO4J_PASSWORD=reposkeintest cargo test -p reposkein-neo4j-io -- --ignored
use reposkein_neo4j_io::Neo4jStore;

fn store() -> Neo4jStore {
    Neo4jStore::from_env().expect("connect to Neo4j (is it running? NEO4J_PASSWORD set?)")
}

#[test]
#[ignore]
fn doctor_reports_version() {
    let s = store();
    let report = s.doctor().unwrap();
    assert!(report.reachable);
    assert!(report.version.starts_with('5') || report.version.starts_with("202"));
}

use reposkein_core::{index_tree, jsonl};
use reposkein_lang_python::PythonExtractor; // add dev-dep below

#[test]
#[ignore]
fn db_round_trip_is_byte_identical() {
    use std::fs;
    let s = store();
    let repo = "rtcheck";
    s.purge(repo).unwrap();

    // Build a small graph from a temp Python tree.
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    fs::write(dir.path().join("app/base.py"), b"def helper():\n    return 1\n").unwrap();
    fs::write(
        dir.path().join("app/svc.py"),
        b"from app.base import helper\n\ndef run():\n    return helper()\n",
    )
    .unwrap();
    let python = PythonExtractor;
    let extractors: &[&dyn reposkein_core::extractor::Extractor] = &[&python];
    let g = index_tree(dir.path(), repo, "app", extractors).unwrap();

    let nodes_before = jsonl::nodes_to_jsonl(&g.nodes);
    let edges_before = jsonl::edges_to_jsonl(&g.edges);

    s.import_graph(repo, &g).unwrap();
    let g2 = s.export_graph(repo).unwrap();

    assert_eq!(jsonl::nodes_to_jsonl(&g2.nodes), nodes_before, "nodes round-trip");
    assert_eq!(jsonl::edges_to_jsonl(&g2.edges), edges_before, "edges round-trip");

    s.purge(repo).unwrap();
}
