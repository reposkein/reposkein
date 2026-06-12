//! Read a repo's graph back from Neo4j into the core Graph model. Strips the
//! DB-only `repo_id` (and the separately-carried `id`) so the re-serialized
//! JSONL is byte-identical to what the indexer produced.

use crate::convert::bolt_to_json;
use crate::Neo4jStore;
use anyhow::Result;
use neo4rs::{query, BoltType};
use reposkein_core::model::{Edge, Node};
use reposkein_core::Graph;
use serde_json::{Map, Value};

fn bolt_map_to_props(b: &BoltType, drop: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    if let BoltType::Map(m) = b {
        for (k, v) in m.value.iter() {
            let key = k.value.clone();
            if drop.contains(&key.as_str()) {
                continue;
            }
            out.insert(key, bolt_to_json(v));
        }
    }
    out
}

impl Neo4jStore {
    pub fn export_graph(&self, repo: &str) -> Result<Graph> {
        self.rt.block_on(async {
            let mut nodes = Vec::new();
            let mut nr = self
                .graph
                .execute(
                    query(
                        "MATCH (n:Rs {repo_id: $repo}) \
                         RETURN n.id AS id, [l IN labels(n) WHERE l <> 'Rs'] AS labels, \
                         properties(n) AS props",
                    )
                    .param("repo", repo),
                )
                .await?;
            while let Ok(Some(row)) = nr.next().await {
                let id: String = row.get("id")?;
                let labels: Vec<String> = row.get("labels")?;
                let props_bolt: BoltType = row.get("props")?;
                let props = bolt_map_to_props(&props_bolt, &["id", "repo_id"]);
                nodes.push(Node { id, labels, props });
            }

            let mut edges = Vec::new();
            let mut er = self
                .graph
                .execute(
                    query(
                        "MATCH (a:Rs {repo_id: $repo})-[r]->(b:Rs {repo_id: $repo}) \
                         RETURN a.id AS from, type(r) AS type, b.id AS to, \
                         properties(r) AS props",
                    )
                    .param("repo", repo),
                )
                .await?;
            while let Ok(Some(row)) = er.next().await {
                let from: String = row.get("from")?;
                let typ: String = row.get("type")?;
                let to: String = row.get("to")?;
                let props_bolt: BoltType = row.get("props")?;
                let props = bolt_map_to_props(&props_bolt, &[]);
                edges.push(Edge {
                    from,
                    typ,
                    to,
                    props,
                });
            }

            Ok(Graph { nodes, edges })
        })
    }
}
