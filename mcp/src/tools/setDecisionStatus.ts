import type { ToolResult } from "./readCypher.js";
import {
  loadDecisions,
  writeDecision,
  type DecisionRecord,
  type DecisionStatus,
} from "../store/decisions.js";

export interface SetDecisionStatusArgs {
  decision_id: string;
  /** "superseded" is deliberately absent — it only happens via
   *  record_decision's supersedes, which links both directions. */
  status: "accepted" | "rejected" | "deprecated";
}

/** Legal lifecycle transitions. rejected / deprecated / superseded are
 *  terminal; deprecation is for accepted decisions that aged out without a
 *  successor. */
const LEGAL: Record<string, DecisionStatus[]> = {
  proposed: ["accepted", "rejected"],
  accepted: ["deprecated"],
};

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export function makeSetDecisionStatus(repoPath: string) {
  return async (args: SetDecisionStatusArgs): Promise<ToolResult> => {
    try {
      const { decisions } = loadDecisions(repoPath);
      const rec = decisions.find((d) => d.id === args.decision_id);
      if (!rec) return err(`unknown decision: ${args.decision_id}`);
      const allowed = LEGAL[rec.status] ?? [];
      if (!allowed.includes(args.status)) {
        return err(
          `illegal transition ${rec.status} → ${args.status} (allowed from ${rec.status}: ${
            allowed.length ? allowed.join(", ") : "none — terminal status"
          })`
        );
      }
      const updated: DecisionRecord = { ...rec, status: args.status };
      writeDecision(repoPath, updated);
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, decision_id: rec.id, status: args.status }) },
        ],
      };
    } catch (e) {
      return err((e as Error).message);
    }
  };
}
