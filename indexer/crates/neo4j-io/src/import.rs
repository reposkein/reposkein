//! Schema setup and bulk import. Nodes carry a shared `:Rs` label + their
//! semantic label; `repo_id` is added at import (stripped on export).

use crate::convert::json_to_bolt;
use crate::Neo4jStore;
use anyhow::Result;
use neo4rs::{query, BoltList, BoltMap, BoltString, BoltType};
use reposkein_core::model::{Edge, Node};
use reposkein_core::Graph;
use std::collections::BTreeMap;

fn props_to_bolt_map(props: &serde_json::Map<String, serde_json::Value>) -> BoltType {
    let mut m = BoltMap::new();
    for (k, v) in props {
        m.put(BoltString::from(k.as_str()), json_to_bolt(v));
    }
    BoltType::Map(m)
}

/// Whether a Neo4j error from a `CREATE ... IF NOT EXISTS` schema statement
/// indicates the rule already exists. `CREATE INDEX IF NOT EXISTS` is NOT
/// race-free: two concurrent callers (e.g. parallel `load`s, or a fresh DB hit
/// by several processes) can both see "not exists" and both create, so one
/// fails with `EquivalentSchemaRuleAlreadyExists`. The schema is correct either
/// way, so this is benign and must be tolerated.
fn schema_already_exists(err_msg: &str) -> bool {
    err_msg.contains("EquivalentSchemaRuleAlreadyExists") || err_msg.contains("already exists")
}

impl Neo4jStore {
    /// Idempotent constraints + indexes (no APOC). Safe to call repeatedly AND
    /// concurrently: an "already exists" race on creation is treated as success.
    pub fn setup_schema(&self) -> Result<()> {
        self.rt.block_on(async {
            for stmt in [
                "CREATE CONSTRAINT rs_id IF NOT EXISTS FOR (n:Rs) REQUIRE n.id IS UNIQUE",
                "CREATE INDEX rs_repo IF NOT EXISTS FOR (n:Rs) ON (n.repo_id)",
                "CREATE INDEX rs_path IF NOT EXISTS FOR (n:Rs) ON (n.path)",
                "CREATE INDEX rs_name IF NOT EXISTS FOR (n:Rs) ON (n.name)",
                "CREATE INDEX rs_chash IF NOT EXISTS FOR (n:Rs) ON (n.content_hash)",
            ] {
                if let Err(e) = self.graph.run(query(stmt)).await {
                    if schema_already_exists(&e.to_string()) {
                        continue; // benign concurrent-creation race
                    }
                    return Err(e.into());
                }
            }
            Ok(())
        })
    }

    /// Import a Graph for `repo`. MERGE-based, so re-import is idempotent.
    pub fn import_graph(&self, repo: &str, g: &Graph) -> Result<()> {
        self.setup_schema()?;
        self.rt.block_on(async {
            // Nodes grouped by semantic label (labels[0]).
            let mut by_label: BTreeMap<String, Vec<&Node>> = BTreeMap::new();
            for n in &g.nodes {
                let label = n.labels.first().cloned().unwrap_or_else(|| "Rs".into());
                by_label.entry(label).or_default().push(n);
            }
            for (label, nodes) in &by_label {
                // Label is from our fixed schema set — safe to interpolate.
                let q = format!(
                    "UNWIND $rows AS row \
                     MERGE (n:Rs {{id: row.id}}) \
                     SET n += row.props, n.repo_id = $repo \
                     SET n:{label}"
                );
                let mut rows = BoltList::new();
                for n in nodes {
                    let mut row = BoltMap::new();
                    row.put(BoltString::from("id"), BoltType::from(n.id.clone()));
                    row.put(BoltString::from("props"), props_to_bolt_map(&n.props));
                    rows.push(BoltType::Map(row));
                }
                self.graph
                    .run(
                        query(&q)
                            .param("rows", BoltType::List(rows))
                            .param("repo", repo),
                    )
                    .await?;
            }

            // Edges grouped by type.
            let mut by_type: BTreeMap<String, Vec<&Edge>> = BTreeMap::new();
            for e in &g.edges {
                by_type.entry(e.typ.clone()).or_default().push(e);
            }
            for (typ, edges) in &by_type {
                let q = format!(
                    "UNWIND $rows AS row \
                     MATCH (a:Rs {{id: row.from}}) \
                     MATCH (b:Rs {{id: row.to}}) \
                     MERGE (a)-[r:{typ}]->(b) \
                     SET r += row.props"
                );
                let mut rows = BoltList::new();
                for e in edges {
                    let mut row = BoltMap::new();
                    row.put(BoltString::from("from"), BoltType::from(e.from.clone()));
                    row.put(BoltString::from("to"), BoltType::from(e.to.clone()));
                    row.put(BoltString::from("props"), props_to_bolt_map(&e.props));
                    rows.push(BoltType::Map(row));
                }
                self.graph
                    .run(query(&q).param("rows", BoltType::List(rows)))
                    .await?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::schema_already_exists;

    #[test]
    fn classifies_equivalent_schema_rule_as_already_exists() {
        let msg = "Neo4j error `Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists`: \
                   An equivalent index already exists, 'Index( id=6, name='rs_path' )'.";
        assert!(schema_already_exists(msg));
    }

    #[test]
    fn classifies_generic_already_exists() {
        assert!(schema_already_exists("constraint already exists"));
    }

    #[test]
    fn does_not_classify_unrelated_errors() {
        assert!(!schema_already_exists(
            "Neo.ClientError.Statement.SyntaxError: bad query"
        ));
        assert!(!schema_already_exists("connection refused"));
    }
}
