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
      const res = await store.writeSummary(repoId, args.node_id, {
        summary: v.value,
        model: args.model ?? "unknown",
        at: today(),
        by: process.env.REPOSKEIN_AGENT ?? "agent",
      });
      if (res.kind === "not_found") {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "node not found" }) }],
          isError: true,
        };
      }
      if (res.kind === "no_content_hash") {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "node has no content_hash; not summarizable" }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, stale_replaced: res.stale_replaced }) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  };
}
