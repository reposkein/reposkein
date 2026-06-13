import type { TargetRow } from "../profile/types.js";

/** Thrown by stores that cannot execute raw Cypher (e.g. the JSONL store).
 *  read_cypher surfaces the message to the agent. */
export class CypherUnsupportedError extends Error {
  constructor(
    message = "read_cypher is not supported by this store (no Cypher engine). Use get_context_profile."
  ) {
    super(message);
    this.name = "CypherUnsupportedError";
  }
}

/** A single caller/callee row. resolution/confidence are present only for the
 *  direct (1-hop) CALLS edges; absent for 2-hop callees. */
export interface NeighborRow {
  id: string;
  repo_id?: string;
  name: string; // qualified_name
  semantic_summary: string | null;
  summary_of_hash: string | null;
  content_hash: string | null;
  resolution?: string;
  confidence?: number;
}

/** Fields the caller computes (date/agent) and hands to the store to persist. */
export interface SummaryFields {
  summary: string;
  model: string;
  at: string;
  by: string;
}

export type WriteSummaryResult =
  | { kind: "ok"; stale_replaced: boolean }
  | { kind: "not_found" }
  | { kind: "no_content_hash" };

/** Storage abstraction (PRD §4.2). All MCP read/write goes through these
 *  semantic methods so the backend (Neo4j or JSONL) is swappable. Raw Cypher
 *  is exposed only via runRead, used by the read_cypher tool. */
export interface GraphStore {
  /** Exact node by id within the given repos. null if not found. */
  getNode(repoIds: string[], id: string): Promise<TargetRow | null>;

  /** Function/Class nodes in a file matching name OR qualified_name, within the given repos. */
  resolveByPathAndName(
    repoIds: string[],
    filePath: string,
    name: string
  ): Promise<TargetRow[]>;

  /** Function nodes anywhere in the given repos matching name. */
  resolveByName(repoIds: string[], name: string): Promise<TargetRow[]>;

  /** Direct callers of id whose repo_id is in repoIds, ordered by id, capped at limit. */
  callers(repoIds: string[], id: string, limit: number): Promise<NeighborRow[]>;

  /** Direct callees of id whose repo_id is in repoIds, ordered by id, capped at limit. */
  callees(repoIds: string[], id: string, limit: number): Promise<NeighborRow[]>;

  /** Callees exactly 2 hops out whose repo_id is in repoIds, distinct, ordered by id, capped at limit. */
  calleesAt2Hops(
    repoIds: string[],
    id: string,
    limit: number
  ): Promise<NeighborRow[]>;

  /** Attach/refresh a summary; returns whether a stale one was replaced. */
  writeSummary(
    repoId: string,
    id: string,
    fields: SummaryFields
  ): Promise<WriteSummaryResult>;

  /** Transitively federated repo_ids (NOT including repoId itself). */
  federatedRepoIds(repoId: string): Promise<string[]>;

  /** Raw read-only Cypher (read_cypher tool only). Stores without a Cypher
   *  engine throw CypherUnsupportedError. */
  runRead(
    query: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<Record<string, unknown>[]>;

  close(): Promise<void>;
}
