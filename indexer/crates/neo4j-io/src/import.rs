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

impl Neo4jStore {
    /// Idempotent constraints + indexes (no APOC). Safe to call repeatedly.
    pub fn setup_schema(&self) -> Result<()> {
        self.rt.block_on(async {
            for stmt in [
                "CREATE CONSTRAINT rs_id IF NOT EXISTS FOR (n:Rs) REQUIRE n.id IS UNIQUE",
                "CREATE INDEX rs_repo IF NOT EXISTS FOR (n:Rs) ON (n.repo_id)",
                "CREATE INDEX rs_path IF NOT EXISTS FOR (n:Rs) ON (n.path)",
                "CREATE INDEX rs_name IF NOT EXISTS FOR (n:Rs) ON (n.name)",
                "CREATE INDEX rs_chash IF NOT EXISTS FOR (n:Rs) ON (n.content_hash)",
            ] {
                self.graph.run(query(stmt)).await?;
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
                    .run(query(&q).param("rows", BoltType::List(rows)).param("repo", repo))
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
