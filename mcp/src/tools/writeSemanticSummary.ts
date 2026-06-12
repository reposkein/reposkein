import type { GraphStore } from "../store/GraphStore.js";
import { sanitizeSummary } from "../guard/summaryValidation.js";
import type { ToolResult } from "./readCypher.js";

export interface WriteSummaryArgs {
  node_id: string;
  summary: string;
  model?: string;
}

function today(): string {
  // Day-precision ISO date (PRD §6.2.5: no wall-clock timestamps in output).
  return new Date().toISOString().slice(0, 10);
}

export function makeWriteSemanticSummary(store: GraphStore, repoId: string) {
  return async (args: WriteSummaryArgs): Promise<ToolResult> => {
    const v = sanitizeSummary(args.summary);
    if (!v.ok) {
      return { content: [{ type: "text", text: v.error }], isError: true };
    }
    try {
      const rows = await store.runRead(
        "MATCH (n:Rs {id:$id, repo_id:$repo}) " +
          "RETURN n.content_hash AS chash, n.semantic_summary AS old, n.summary_of_hash AS oldhash",
        { id: args.node_id, repo: repoId }
      );
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "node not found" }) }],
          isError: true,
        };
      }
      const row = rows[0]!;
      const stale_replaced =
        row.old != null && (row.oldhash ?? null) !== (row.chash ?? null);

      await store.runWrite(
        "MATCH (n:Rs {id:$id, repo_id:$repo}) " +
          "SET n.semantic_summary=$s, n.summary_of_hash=n.content_hash, " +
          "n.summary_model=$m, n.summary_at=$at, n.summary_by=$by",
        {
          id: args.node_id,
          repo: repoId,
          s: v.value,
          m: args.model ?? "unknown",
          at: today(),
          by: process.env.REPOSKEIN_AGENT ?? "agent",
        }
      );
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, stale_replaced }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  };
}
