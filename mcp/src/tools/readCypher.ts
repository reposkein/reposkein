import { assertReadOnly } from "../guard/readonly.js";
import { applyCaps } from "../guard/caps.js";
import type { GraphStore } from "../store/GraphStore.js";

export interface ReadCypherArgs {
  query: string;
  params?: Record<string, unknown>;
  federated?: boolean;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Builds the read_cypher handler bound to a store and (optional) repo scope. */
export function makeReadCypher(store: GraphStore, repoId?: string) {
  return async (args: ReadCypherArgs): Promise<ToolResult> => {
    const { query, params } = args;
    try {
      assertReadOnly(query);
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const merged: Record<string, unknown> = { ...(params ?? {}) };
    if (repoId !== undefined) merged.repo_id = repoId;
    try {
      const rows = await store.runRead(query, merged, { timeoutMs: 10_000 });
      const { rows: capped, truncated } = applyCaps(rows);
      return {
        content: [
          { type: "text", text: JSON.stringify({ rows: capped, truncated }) },
        ],
      };
    } catch (e) {
      // Verbatim Neo4j message so the agent can self-correct (PRD §7.2).
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
  };
}
