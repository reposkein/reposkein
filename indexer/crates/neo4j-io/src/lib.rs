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
                Ok(DoctorReport {
                    reachable: true,
                    version,
                    edition,
                })
            } else {
                Ok(DoctorReport {
                    reachable: false,
                    version: String::new(),
                    edition: String::new(),
                })
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

    /// Runs a Cypher query that returns a single `c` (count) column. Used in
    /// tests and diagnostics; the query must RETURN an integer named `c`.
    pub fn run_count(&self, cypher: &str) -> Result<i64> {
        self.rt.block_on(async {
            let mut r = self.graph.execute(query(cypher)).await?;
            if let Ok(Some(row)) = r.next().await {
                let c: i64 = row.get("c")?;
                Ok(c)
            } else {
                Ok(0)
            }
        })
    }

    /// Creates DB-only `FEDERATES_TO {stitched:true}` edges from each proxy
    /// Repository (carrying `federated_repo_id`) to the matching child-root
    /// Repository (`root_path:'.'` with that repo_id). Idempotent (MERGE).
    /// These cross repo_id boundaries, so export (both-endpoint scoping)
    /// ignores them — the committed round-trip is unaffected. Returns the
    /// number of stitch edges present after the call.
    pub fn stitch_federation(&self) -> Result<u64> {
        self.rt.block_on(async {
            let mut r = self
                .graph
                .execute(query(
                    "MATCH (p:Rs:Repository) WHERE p.federated_repo_id IS NOT NULL \
                     MATCH (c:Rs:Repository {root_path: '.'}) WHERE c.repo_id = p.federated_repo_id \
                     MERGE (p)-[s:FEDERATES_TO {stitched: true}]->(c) \
                     RETURN count(s) AS c",
                ))
                .await?;
            if let Ok(Some(row)) = r.next().await {
                let c: i64 = row.get("c")?;
                Ok(c as u64)
            } else {
                Ok(0)
            }
        })
    }

    /// Creates DB-only cross-repo `CALLS` edges from each caller's committed
    /// `external_calls` (imported-but-unresolved names) to the matching function
    /// in another federated repo. Only an UNAMBIGUOUS match (exactly one
    /// federated function with that name, in a different repo) produces an edge;
    /// ambiguous/absent names are skipped. Edges are `cross_repo:true,
    /// stitched:true` and cross repo_id boundaries, so per-repo export ignores
    /// them. Idempotent (MERGE). Returns the number of such edges after the call.
    pub fn stitch_cross_repo_calls(&self, repo_ids: &[String]) -> Result<u64> {
        let ids: Vec<String> = repo_ids.to_vec();
        self.rt.block_on(async {
            // For each (caller f, external name), collect the federated
            // functions named `name` in OTHER repos; link only when exactly one.
            let mut r = self
                .graph
                .execute(
                    query(
                        "MATCH (f:Rs:Function) \
                         WHERE f.repo_id IN $ids AND f.external_calls IS NOT NULL \
                         UNWIND f.external_calls AS name \
                         MATCH (m:Rs:Function {name: name}) \
                         WHERE m.repo_id IN $ids AND m.repo_id <> f.repo_id \
                         WITH f, collect(DISTINCT m) AS matches \
                         WHERE size(matches) = 1 \
                         WITH f, matches[0] AS m \
                         MERGE (f)-[s:CALLS {cross_repo: true}]->(m) \
                         ON CREATE SET s.resolution = 'name_match', s.confidence = 0.5, \
                                       s.stitched = true, s.call_sites = 1 \
                         RETURN count(s) AS c",
                    )
                    .param("ids", ids),
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

    /// Creates DB-only cross-repo `IMPORTS` edges from each File's committed
    /// `external_import_targets` (MF5-M1: already-resolved child File ids) to
    /// the matching File — when that File is loaded and in a different repo.
    /// Edges are `cross_repo:true, stitched:true` and cross repo_id boundaries,
    /// so per-repo export ignores them. Idempotent (MERGE). Returns the edge
    /// count after the call.
    pub fn stitch_cross_repo_imports(&self, repo_ids: &[String]) -> Result<u64> {
        let ids: Vec<String> = repo_ids.to_vec();
        self.rt.block_on(async {
            let mut r = self
                .graph
                .execute(
                    query(
                        "MATCH (f:Rs:File) \
                         WHERE f.repo_id IN $ids AND f.external_import_targets IS NOT NULL \
                         UNWIND f.external_import_targets AS target \
                         MATCH (t:Rs:File {id: target}) \
                         WHERE t.repo_id IN $ids AND t.repo_id <> f.repo_id \
                         MERGE (f)-[s:IMPORTS {cross_repo: true}]->(t) \
                         ON CREATE SET s.stitched = true \
                         RETURN count(s) AS c",
                    )
                    .param("ids", ids),
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
