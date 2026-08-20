import type { GraphStore } from "../store/GraphStore.js";
import type { ToolResult } from "./readCypher.js";
import { neutralizeSummary } from "../guard/summaryValidation.js";
import { anchorRepoIds, loadDecisions, resolveAnchorStates } from "../store/decisions.js";

export interface GetDecisionArgs {
  decision_id: string;
}

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function neutralize(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return neutralizeSummary(s) ?? "";
}

export function makeGetDecision(store: GraphStore, repoId: string, repoPath: string) {
  return async (args: GetDecisionArgs): Promise<ToolResult> => {
    try {
      const { decisions } = loadDecisions(repoPath);
      const rec = decisions.find((d) => d.id === args.decision_id);
      if (!rec) return err(`unknown decision: ${args.decision_id}`);
      const resolved = await resolveAnchorStates(store, await anchorRepoIds(store, repoId), rec.anchors);
      // The chain in both directions: what this supersedes (recorded) and
      // what supersedes it (recorded on flip, recovered from siblings if the
      // flip was lost to merge damage).
      const supersededBy =
        rec.superseded_by ??
        decisions.find((d) => d.supersedes.includes(rec.id))?.id;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: rec.id,
              title: neutralize(rec.title),
              status: rec.status,
              context: neutralize(rec.context),
              decision: neutralize(rec.decision),
              ...(rec.consequences !== undefined ? { consequences: neutralize(rec.consequences) } : {}),
              ...(rec.alternatives !== undefined ? { alternatives: neutralize(rec.alternatives) } : {}),
              anchors: resolved.map((a) => ({
                node_id: a.node_id,
                path: a.path,
                kind: a.kind,
                state: a.state,
                ...(a.resolved_node_id && a.resolved_node_id !== a.node_id
                  ? { resolved_node_id: a.resolved_node_id }
                  : {}),
              })),
              paths: rec.paths,
              supersedes: rec.supersedes,
              ...(supersededBy ? { superseded_by: supersededBy } : {}),
              decided_at: rec.decided_at,
              decided_by: rec.decided_by,
              trigger: rec.trigger,
            }),
          },
        ],
      };
    } catch (e) {
      return err((e as Error).message);
    }
  };
}
