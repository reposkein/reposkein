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

#[test]
#[ignore]
fn stitch_links_proxy_to_child_root() {
    use reposkein_core::model::Node;
    use serde_json::json;
    let s = reposkein_neo4j_io::Neo4jStore::from_env().unwrap();
    s.purge("fedroot").unwrap();
    s.purge("fedchild").unwrap();

    // Root graph: root repo node + a proxy pointing at the child.
    let root_graph = reposkein_core::Graph {
        nodes: vec![
            Node::new("rs1:fedroot:repo:.", "Repository")
                .set("root_path", json!("."))
                .set("is_nested", json!(false)),
            Node::new("rs1:fedroot:repo:vendor/c", "Repository")
                .set("root_path", json!("vendor/c"))
                .set("is_nested", json!(true))
                .set("federated_repo_id", json!("fedchild")),
        ],
        edges: vec![],
    };
    s.import_graph("fedroot", &root_graph).unwrap();

    // Child graph: its own root repo node.
    let child_graph = reposkein_core::Graph {
        nodes: vec![Node::new("rs1:fedchild:repo:.", "Repository")
            .set("root_path", json!("."))
            .set("is_nested", json!(false))],
        edges: vec![],
    };
    s.import_graph("fedchild", &child_graph).unwrap();

    let n = s.stitch_federation().unwrap();
    assert!(n >= 1, "at least one stitch created");

    // Verify the proxy -> child-root stitch exists via run_count.
    let c = s
        .run_count(
            "MATCH (:Rs:Repository {id:'rs1:fedroot:repo:vendor/c'})\
             -[r:FEDERATES_TO {stitched:true}]->\
             (:Rs:Repository {id:'rs1:fedchild:repo:.'}) RETURN count(r) AS c",
        )
        .unwrap();
    assert_eq!(c, 1, "exactly one stitch edge proxy->child-root");

    s.purge("fedroot").unwrap();
    s.purge("fedchild").unwrap();
}

#[test]
#[ignore]
fn cross_repo_call_stitches_to_unique_child_function() {
    use reposkein_core::Graph;
    use serde_json::json;
    let s = store();
    s.purge("xrA").unwrap();
    s.purge("xrB").unwrap();

    // A.run records an external call to "helper"; B defines helper.
    let a_run = Node::new("rs1:xrA:func:svc.py#run@0", "Function")
        .set("name", json!("run"))
        .set("qualified_name", json!("run"))
        .set("external_calls", json!(["helper"]));
    let b_helper = Node::new("rs1:xrB:func:base.py#helper@0", "Function")
        .set("name", json!("helper"))
        .set("qualified_name", json!("helper"));
    s.import_graph(
        "xrA",
        &Graph {
            nodes: vec![a_run],
            edges: vec![],
        },
    )
    .unwrap();
    s.import_graph(
        "xrB",
        &Graph {
            nodes: vec![b_helper],
            edges: vec![],
        },
    )
    .unwrap();

    let n = s
        .stitch_cross_repo_calls(&["xrA".to_string(), "xrB".to_string()])
        .unwrap();
    assert!(n >= 1, "one cross-repo CALLS edge created");

    let c = s
        .run_count(
            "MATCH (:Rs:Function {id:'rs1:xrA:func:svc.py#run@0'})\
             -[r:CALLS {cross_repo:true}]->\
             (:Rs:Function {id:'rs1:xrB:func:base.py#helper@0'}) RETURN count(r) AS c",
        )
        .unwrap();
    assert_eq!(c, 1, "exactly one cross-repo CALLS A.run -> B.helper");

    s.purge("xrA").unwrap();
    s.purge("xrB").unwrap();
}

#[test]
#[ignore]
fn ambiguous_cross_repo_call_is_skipped() {
    use reposkein_core::Graph;
    use serde_json::json;
    let s = store();
    s.purge("xrA").unwrap();
    s.purge("xrB").unwrap();
    s.purge("xrC").unwrap();

    let a_run = Node::new("rs1:xrA:func:svc.py#run@0", "Function")
        .set("name", json!("run"))
        .set("qualified_name", json!("run"))
        .set("external_calls", json!(["helper"]));
    let b_helper = Node::new("rs1:xrB:func:base.py#helper@0", "Function")
        .set("name", json!("helper"))
        .set("qualified_name", json!("helper"));
    let c_helper = Node::new("rs1:xrC:func:other.py#helper@0", "Function")
        .set("name", json!("helper"))
        .set("qualified_name", json!("helper"));
    s.import_graph(
        "xrA",
        &Graph {
            nodes: vec![a_run],
            edges: vec![],
        },
    )
    .unwrap();
    s.import_graph(
        "xrB",
        &Graph {
            nodes: vec![b_helper],
            edges: vec![],
        },
    )
    .unwrap();
    s.import_graph(
        "xrC",
        &Graph {
            nodes: vec![c_helper],
            edges: vec![],
        },
    )
    .unwrap();

    s.stitch_cross_repo_calls(&["xrA".into(), "xrB".into(), "xrC".into()])
        .unwrap();
    let c = s
        .run_count(
            "MATCH (:Rs:Function {id:'rs1:xrA:func:svc.py#run@0'})-[r:CALLS {cross_repo:true}]->() RETURN count(r) AS c",
        )
        .unwrap();
    assert_eq!(c, 0, "ambiguous name (helper in 2 repos) creates no edge");

    s.purge("xrA").unwrap();
    s.purge("xrB").unwrap();
    s.purge("xrC").unwrap();
}

#[test]
#[ignore]
fn cross_repo_imports_stitch_links_file_to_child_file() {
    use reposkein_core::Graph;
    use serde_json::json;
    let s = store();
    s.purge("xiA").unwrap();
    s.purge("xiB").unwrap();

    // A/svc.py records a cross-repo import target = B/base.py's File id.
    let a_svc = Node::new("rs1:xiA:file:svc.py", "File")
        .set("path", json!("svc.py"))
        .set("external_import_targets", json!(["rs1:xiB:file:base.py"]));
    let b_base = Node::new("rs1:xiB:file:base.py", "File").set("path", json!("base.py"));
    // This import + load also proves Neo4j accepts the string-array property.
    s.import_graph(
        "xiA",
        &Graph {
            nodes: vec![a_svc],
            edges: vec![],
        },
    )
    .unwrap();
    s.import_graph(
        "xiB",
        &Graph {
            nodes: vec![b_base],
            edges: vec![],
        },
    )
    .unwrap();

    let n = s
        .stitch_cross_repo_imports(&["xiA".to_string(), "xiB".to_string()])
        .unwrap();
    assert!(n >= 1, "one cross-repo IMPORTS edge created");

    let c = s
        .run_count(
            "MATCH (:Rs:File {id:'rs1:xiA:file:svc.py'})\
             -[r:IMPORTS {cross_repo:true}]->\
             (:Rs:File {id:'rs1:xiB:file:base.py'}) RETURN count(r) AS c",
        )
        .unwrap();
    assert_eq!(c, 1, "exactly one cross-repo IMPORTS A/svc.py -> B/base.py");

    s.purge("xiA").unwrap();
    s.purge("xiB").unwrap();
}

#[test]
#[ignore]
fn cross_repo_imports_skips_missing_target() {
    use reposkein_core::Graph;
    use serde_json::json;
    let s = store();
    s.purge("xiA").unwrap();
    // Target child File is NOT loaded → no edge (graceful).
    let a_svc = Node::new("rs1:xiA:file:svc.py", "File")
        .set("path", json!("svc.py"))
        .set(
            "external_import_targets",
            json!(["rs1:xiGHOST:file:nope.py"]),
        );
    s.import_graph(
        "xiA",
        &Graph {
            nodes: vec![a_svc],
            edges: vec![],
        },
    )
    .unwrap();
    s.stitch_cross_repo_imports(&["xiA".to_string()]).unwrap();
    let c = s
        .run_count(
            "MATCH (:Rs:File {id:'rs1:xiA:file:svc.py'})-[r:IMPORTS {cross_repo:true}]->() RETURN count(r) AS c",
        )
        .unwrap();
    assert_eq!(c, 0, "no edge when the target File isn't loaded");
    s.purge("xiA").unwrap();
}

#[test]
#[ignore]
fn confidence_floats_round_trip_byte_identical() {
    // PRD §6.2.4 fixes confidence to 2 decimals; §6.2.7 guarantees load->export
    // byte-identical. Exercise the exact values the resolver emits (0.5/0.7 and
    // round2(1/n) like 0.33/0.14) through a Bolt float round-trip.
    use reposkein_core::model::Edge;
    use reposkein_core::Graph;
    let s = store();
    let repo = "conffloat";
    s.purge(repo).unwrap();

    let node = |n: u32| {
        Node::new(format!("rs1:conffloat:func:a#f{n}@0"), "Function")
            .set("content_hash", serde_json::json!("h"))
    };
    let edge = |from: u32, to: u32, conf: f64| {
        let mut e = Edge::new(
            format!("rs1:conffloat:func:a#f{from}@0"),
            "CALLS",
            format!("rs1:conffloat:func:a#f{to}@0"),
        );
        e.props
            .insert("resolution".into(), serde_json::json!("name_match"));
        e.props.insert("confidence".into(), serde_json::json!(conf));
        e.props.insert("call_sites".into(), serde_json::json!(1));
        e
    };
    let confs = [0.5_f64, 0.7, 0.33, 0.14, 1.0];
    let g = Graph {
        nodes: (0..=confs.len() as u32).map(node).collect(),
        edges: confs
            .iter()
            .enumerate()
            .map(|(i, c)| edge(i as u32, i as u32 + 1, *c))
            .collect(),
    };

    let before = jsonl::edges_to_jsonl(&g.edges);
    s.import_graph(repo, &g).unwrap();
    let g2 = s.export_graph(repo).unwrap();
    assert_eq!(
        jsonl::edges_to_jsonl(&g2.edges),
        before,
        "confidence floats must survive a Bolt round-trip byte-identical"
    );
    s.purge(repo).unwrap();
}
