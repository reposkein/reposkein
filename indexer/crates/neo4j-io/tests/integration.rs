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
