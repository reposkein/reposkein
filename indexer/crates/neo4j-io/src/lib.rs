//! Neo4j storage I/O for the indexer. Async neo4rs wrapped in a sync API via a
//! private tokio runtime, so the CLI stays synchronous.

pub mod convert;
pub mod export;
pub mod import;

use anyhow::Result;
use neo4rs::{query, Graph};
use tokio::runtime::Runtime;

pub struct Neo4jStore {
    pub(crate) graph: Graph,
    pub(crate) rt: Runtime,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DoctorReport {
    pub reachable: bool,
    pub version: String,
    pub edition: String,
}

impl Neo4jStore {
    /// Connect using explicit credentials.
    pub fn connect(uri: &str, user: &str, password: &str) -> Result<Self> {
        let rt = Runtime::new()?;
        let graph = rt.block_on(Graph::new(uri, user, password))?;
        Ok(Self { graph, rt })
    }

    /// Connect from env: NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD.
    pub fn from_env() -> Result<Self> {
        let uri = std::env::var("NEO4J_URI").unwrap_or_else(|_| "neo4j://localhost:7687".into());
        let user = std::env::var("NEO4J_USER").unwrap_or_else(|_| "neo4j".into());
        let password = std::env::var("NEO4J_PASSWORD")
            .map_err(|_| anyhow::anyhow!("NEO4J_PASSWORD must be set"))?;
        Self::connect(&uri, &user, &password)
    }

    pub fn doctor(&self) -> Result<DoctorReport> {
        self.rt.block_on(async {
            let mut r = self
                .graph
                .execute(query(
                    "CALL dbms.components() YIELD name, versions, edition \
                     RETURN versions[0] AS version, edition",
                ))
                .await?;
            if let Ok(Some(row)) = r.next().await {
                let version: String = row.get("version")?;
                let edition: String = row.get("edition")?;
                Ok(DoctorReport { reachable: true, version, edition })
            } else {
                Ok(DoctorReport { reachable: false, version: String::new(), edition: String::new() })
            }
        })
    }

    /// Delete all nodes (and their edges) for a repo_id.
    pub fn purge(&self, repo: &str) -> Result<u64> {
        self.rt.block_on(async {
            let mut r = self
                .graph
                .execute(
                    query("MATCH (n:Rs {repo_id: $repo}) DETACH DELETE n RETURN count(n) AS c")
                        .param("repo", repo),
                )
                .await?;
            if let Ok(Some(row)) = r.next().await {
                let c: i64 = row.get("c")?;
                Ok(c as u64)
            } else {
                Ok(0)
            }
        })
    }
}
