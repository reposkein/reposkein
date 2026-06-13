import neo4j, { type Driver } from "neo4j-driver";
import type {
  GraphStore,
  NeighborRow,
  SummaryFields,
  WriteSummaryResult,
} from "./GraphStore.js";
import type { TargetRow } from "../profile/types.js";

export class Neo4jGraphStore implements GraphStore {
  private driver: Driver;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      disableLosslessIntegers: true,
    });
  }

  /** Connect using env: NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD. */
  static fromEnv(): Neo4jGraphStore {
    const uri = process.env.NEO4J_URI ?? "neo4j://localhost:7687";
    const user = process.env.NEO4J_USER ?? "neo4j";
    const password = process.env.NEO4J_PASSWORD;
    if (!password) throw new Error("NEO4J_PASSWORD must be set");
    return new Neo4jGraphStore(uri, user, password);
  }

  // Projection for a resolved target node (was resolve.ts TARGET_RETURN).
  private static TARGET_RETURN =
    "t.id AS id, t.name AS name, t.qualified_name AS qualified_name, t.file_path AS file_path, " +
    "t.start_line AS start_line, t.end_line AS end_line, t.semantic_summary AS semantic_summary, " +
    "t.summary_of_hash AS summary_of_hash, t.content_hash AS content_hash, " +
    "[l IN labels(t) WHERE l <> 'Rs'] AS labels, t.repo_id AS repo_id";

  // Projection for a neighbor node (was assemble.ts NEIGHBOR_RETURN). Caller
  // prefixes `x.id ` and may append edge props.
  private static NEIGHBOR_RETURN =
    "AS id, x.qualified_name AS name, x.semantic_summary AS semantic_summary, " +
    "x.summary_of_hash AS summary_of_hash, x.content_hash AS content_hash, x.repo_id AS repo_id";

  private static toTargetRow(r: Record<string, unknown>): TargetRow {
    return {
      id: r.id as string,
      repo_id: (r.repo_id as string) ?? "",
      name: r.name as string,
      qualified_name: (r.qualified_name as string) ?? (r.name as string),
      file_path: (r.file_path as string) ?? "",
      start_line: (r.start_line as number) ?? 0,
      end_line: (r.end_line as number) ?? 0,
      semantic_summary: (r.semantic_summary as string) ?? null,
      summary_of_hash: (r.summary_of_hash as string) ?? null,
      content_hash: (r.content_hash as string) ?? null,
      labels: (r.labels as string[]) ?? [],
    };
  }

  private static toNeighborRow(r: Record<string, unknown>): NeighborRow {
    const row: NeighborRow = {
      id: r.id as string,
      name: (r.name as string) ?? "",
      semantic_summary: (r.semantic_summary as string) ?? null,
      summary_of_hash: (r.summary_of_hash as string) ?? null,
      content_hash: (r.content_hash as string) ?? null,
    };
    if (r.resolution !== undefined && r.resolution !== null)
      row.resolution = r.resolution as string;
    if (r.confidence !== undefined && r.confidence !== null)
      row.confidence = r.confidence as number;
    if (typeof r.repo_id === "string") row.repo_id = r.repo_id;
    if (r.cross_repo === true) row.cross_repo = true;
    return row;
  }

  async getNode(repoIds: string[], id: string): Promise<TargetRow | null> {
    const rows = await this.runRead(
      `MATCH (t:Rs {id:$id}) WHERE t.repo_id IN $repo_ids RETURN ${Neo4jGraphStore.TARGET_RETURN}`,
      { id, repo_ids: repoIds }
    );
    return rows.length === 1 ? Neo4jGraphStore.toTargetRow(rows[0]!) : null;
  }

  async resolveByPathAndName(
    repoIds: string[],
    filePath: string,
    name: string
  ): Promise<TargetRow[]> {
    const rows = await this.runRead(
      `MATCH (t:Rs {file_path:$path}) ` +
        `WHERE t.repo_id IN $repo_ids AND (t.name = $name OR t.qualified_name = $name) AND (t:Function OR t:Class) ` +
        `RETURN ${Neo4jGraphStore.TARGET_RETURN}`,
      { repo_ids: repoIds, path: filePath, name }
    );
    return rows.map(Neo4jGraphStore.toTargetRow);
  }

  async resolveByName(repoIds: string[], name: string): Promise<TargetRow[]> {
    const rows = await this.runRead(
      `MATCH (t:Function {name:$name}) WHERE t.repo_id IN $repo_ids RETURN ${Neo4jGraphStore.TARGET_RETURN}`,
      { repo_ids: repoIds, name }
    );
    return rows.map(Neo4jGraphStore.toTargetRow);
  }

  async callers(repoIds: string[], id: string, limit: number): Promise<NeighborRow[]> {
    const rows = await this.runRead(
      `MATCH (x:Function)-[r:CALLS]->(t:Rs {id:$id}) WHERE x.repo_id IN $repo_ids ` +
        `RETURN x.id ${Neo4jGraphStore.NEIGHBOR_RETURN}, r.resolution AS resolution, r.confidence AS confidence, r.cross_repo AS cross_repo ` +
        `ORDER BY x.id LIMIT $limit`,
      { id, repo_ids: repoIds, limit: neo4j.int(limit) }
    );
    return rows.map(Neo4jGraphStore.toNeighborRow);
  }

  async callees(repoIds: string[], id: string, limit: number): Promise<NeighborRow[]> {
    const rows = await this.runRead(
      `MATCH (t:Rs {id:$id})-[r:CALLS]->(x:Function) WHERE x.repo_id IN $repo_ids ` +
        `RETURN x.id ${Neo4jGraphStore.NEIGHBOR_RETURN}, r.resolution AS resolution, r.confidence AS confidence, r.cross_repo AS cross_repo ` +
        `ORDER BY x.id LIMIT $limit`,
      { id, repo_ids: repoIds, limit: neo4j.int(limit) }
    );
    return rows.map(Neo4jGraphStore.toNeighborRow);
  }

  async calleesAt2Hops(repoIds: string[], id: string, limit: number): Promise<NeighborRow[]> {
    const rows = await this.runRead(
      `MATCH (t:Rs {id:$id})-[:CALLS*2..2]->(x:Function) WHERE x.repo_id IN $repo_ids ` +
        `RETURN DISTINCT x.id ${Neo4jGraphStore.NEIGHBOR_RETURN} ` +
        `ORDER BY x.id LIMIT $limit`,
      { id, repo_ids: repoIds, limit: neo4j.int(limit) }
    );
    return rows.map(Neo4jGraphStore.toNeighborRow);
  }

  async writeSummary(
    repoId: string,
    id: string,
    fields: SummaryFields
  ): Promise<WriteSummaryResult> {
    const rows = await this.runRead(
      "MATCH (n:Rs {id:$id, repo_id:$repo}) " +
        "RETURN n.content_hash AS chash, n.semantic_summary AS old, n.summary_of_hash AS oldhash",
      { id, repo: repoId }
    );
    if (rows.length === 0) return { kind: "not_found" };
    const row = rows[0]!;
    if (row.chash === null || row.chash === undefined) {
      return { kind: "no_content_hash" };
    }
    const stale_replaced =
      row.old != null && (row.oldhash ?? null) !== (row.chash ?? null);
    await this.runWrite(
      "MATCH (n:Rs {id:$id, repo_id:$repo}) " +
        "SET n.semantic_summary=$s, n.summary_of_hash=n.content_hash, " +
        "n.summary_model=$m, n.summary_at=$at, n.summary_by=$by",
      { id, repo: repoId, s: fields.summary, m: fields.model, at: fields.at, by: fields.by }
    );
    return { kind: "ok", stale_replaced };
  }

  async federatedRepoIds(repoId: string): Promise<string[]> {
    const rows = await this.runRead(
      "MATCH (r:Repository {repo_id: $repo_id, root_path: '.'})-[:FEDERATES_TO*1..8]->(x:Repository) " +
        "WHERE x.federated_repo_id IS NOT NULL RETURN DISTINCT x.federated_repo_id AS id",
      { repo_id: repoId },
      { timeoutMs: 5000 }
    );
    const ids: string[] = [];
    for (const r of rows) if (typeof r.id === "string") ids.push(r.id);
    return ids;
  }

  async runRead(
    query: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>[]> {
    const session = this.driver.session({
      defaultAccessMode: neo4j.session.READ,
    });
    try {
      const result = await session.run(query, params, {
        timeout: opts.timeoutMs ?? 10_000,
      });
      return result.records.map((r) => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  async runWrite(
    query: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>[]> {
    const session = this.driver.session({
      defaultAccessMode: neo4j.session.WRITE,
    });
    try {
      const result = await session.run(query, params, {
        timeout: opts.timeoutMs ?? 10_000,
      });
      return result.records.map((r) => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
