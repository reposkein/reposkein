//! Integration tests requiring a running Neo4j. Run with:
//!   NEO4J_PASSWORD=reposkeintest cargo test -p reposkein-neo4j-io -- --ignored
use reposkein_core::model::Node;
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
    fs::write(
        dir.path().join("app/base.py"),
        b"def helper():\n    return 1\n",
    )
    .unwrap();
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

    assert_eq!(
        jsonl::nodes_to_jsonl(&g2.nodes),
        nodes_before,
        "nodes round-trip"
    );
    assert_eq!(
        jsonl::edges_to_jsonl(&g2.edges),
        edges_before,
        "edges round-trip"
    );

    s.purge(repo).unwrap();
}

#[test]
#[ignore]
fn db_summary_grafts_onto_fresh_structure() {
    use serde_json::json;
    let s = Neo4jStore::from_env().unwrap();
    let repo = "graftdb";
    s.purge(repo).unwrap();

    // Simulate the agent: a Function node in the DB carrying a summary stamped
    // to content_hash "H".
    let node = Node::new("rs1:graftdb:func:m.py#f@0", "Function")
        .set("name", json!("f"))
        .set("qualified_name", json!("f"))
        .set("file_path", json!("m.py"))
        .set("content_hash", json!("H"))
        .set("semantic_summary", json!("does the thing"))
        .set("summary_of_hash", json!("H"));
    let g = reposkein_core::Graph {
        nodes: vec![node],
        edges: vec![],
    };
    s.import_graph(repo, &g).unwrap();

    // Fresh re-extraction would produce the same structure (content_hash "H")
    // WITHOUT a summary; grafting the DB export must restore the summary.
    let fresh = vec![Node::new("rs1:graftdb:func:m.py#f@0", "Function")
        .set("name", json!("f"))
        .set("qualified_name", json!("f"))
        .set("file_path", json!("m.py"))
        .set("content_hash", json!("H"))];
    let db_nodes = s.export_graph(repo).unwrap().nodes;
    let grafted = reposkein_core::merge::graft_summaries(&fresh, &db_nodes);
    let f = grafted
        .iter()
        .find(|n| n.id == "rs1:graftdb:func:m.py#f@0")
        .unwrap();
    assert_eq!(
        f.props.get("semantic_summary"),
        Some(&json!("does the thing"))
    );

    // If the source changed (content_hash differs) the DB summary must NOT graft.
    let changed =
        vec![Node::new("rs1:graftdb:func:m.py#f@0", "Function").set("content_hash", json!("H2"))];
    let g2 = reposkein_core::merge::graft_summaries(&changed, &db_nodes);
    assert!(
        g2[0].props.get("semantic_summary").is_none(),
        "stale DB summary not grafted"
    );

    s.purge(repo).unwrap();
}
