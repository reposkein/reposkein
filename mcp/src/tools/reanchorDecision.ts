import type { GraphStore } from "../store/GraphStore.js";
import type { ToolResult } from "./readCypher.js";
import { anchorRepoIds, loadDecisions } from "../store/decisions.js";
import { applyReanchor, planReanchor, type ReanchorPlan } from "../store/reanchor.js";

export interface ReanchorDecisionArgs {
  decision_id?: string;
  dry_run?: boolean;
}

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function planReport(plan: ReanchorPlan): Record<string, unknown> {
  return {
    decision_id: plan.decision_id,
    changed: plan.changed,
    unresolved: plan.unresolved,
    anchors: plan.anchors.map((a) => ({
      node_id: a.anchor.node_id,
      action: a.action,
      ...(a.to ? { to_node_id: a.to.node_id } : {}),
      ...(a.candidates !== undefined ? { candidates: a.candidates } : {}),
    })),
  };
}

/** Mechanical anchor repair (REP-24): rebinds anchors whose node moved or
 *  whose id churned, on confident matches only. Prose and (v2) body hash are
 *  untouched; staleness flags survive — reaffirm_decision clears those. */
export function makeReanchorDecision(
  store: GraphStore,
  repoId: string,
  repoPath: string,
  opts: { today?: () => string } = {}
) {
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  return async (args: ReanchorDecisionArgs): Promise<ToolResult> => {
    try {
      const { decisions } = loadDecisions(repoPath);
      const targets = args.decision_id
        ? decisions.filter((d) => d.id === args.decision_id)
        : decisions.filter((d) => d.anchors.length > 0);
      if (args.decision_id && targets.length === 0) return err(`unknown decision: ${args.decision_id}`);
      const repoIds = await anchorRepoIds(store, repoId);
      // Hoisted so every decision in this call gets the same stamp — a sweep
      // straddling midnight must not split across two dates.
      const reanchoredAt = today();
      const results: Record<string, unknown>[] = [];
      for (const rec of targets) {
        const plan = await planReanchor(store, repoIds, rec);
        if (!args.dry_run) applyReanchor(repoPath, rec, plan, reanchoredAt);
        results.push(planReport(plan));
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, dry_run: args.dry_run === true, results }) },
        ],
      };
    } catch (e) {
      return err((e as Error).message);
    }
  };
}
