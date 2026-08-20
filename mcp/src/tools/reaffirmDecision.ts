import type { GraphStore } from "../store/GraphStore.js";
import type { ToolResult } from "./readCypher.js";
import {
  computeBodyHash,
  loadDecisions,
  resolveAnchorStates,
  writeDecision,
  type DecisionAnchor,
  type DecisionRecord,
} from "../store/decisions.js";

export interface ReaffirmDecisionArgs {
  decision_id: string;
}

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** "This decision is still correct": re-stamps every anchor from the live
 *  graph — stale anchors get the current hash, moved anchors are rebound to
 *  their recovered node — clearing review flags without supersede spam. The
 *  prose body never changes; body_hash is re-signed because rebinding an
 *  anchor updates the governed node list it covers. */
export function makeReaffirmDecision(store: GraphStore, repoId: string, repoPath: string) {
  return async (args: ReaffirmDecisionArgs): Promise<ToolResult> => {
    try {
      const { decisions } = loadDecisions(repoPath);
      const rec = decisions.find((d) => d.id === args.decision_id);
      if (!rec) return err(`unknown decision: ${args.decision_id}`);

      const resolved = await resolveAnchorStates(store, [repoId], rec.anchors);
      const anchors: DecisionAnchor[] = [];
      const results: { node_id: string; state: string }[] = [];
      for (const r of resolved) {
        results.push({ node_id: r.node_id, state: r.state });
        if (r.state === "orphaned" || !r.resolved_node_id) {
          anchors.push({ node_id: r.node_id, path: r.path, name: r.name, kind: r.kind, hash: r.hash });
          continue;
        }
        const live = await store.getNode([repoId], r.resolved_node_id);
        if (!live) {
          anchors.push({ node_id: r.node_id, path: r.path, name: r.name, kind: r.kind, hash: r.hash });
          continue;
        }
        anchors.push({
          node_id: live.id,
          path: live.file_path,
          name: live.qualified_name || live.name,
          kind: live.labels[0] ?? r.kind,
          hash: live.content_hash,
        });
      }
      const updated: DecisionRecord = { ...rec, anchors, body_hash: "" };
      updated.body_hash = computeBodyHash(updated);
      writeDecision(repoPath, updated);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, decision_id: rec.id, anchors: results }),
          },
        ],
      };
    } catch (e) {
      return err((e as Error).message);
    }
  };
}
