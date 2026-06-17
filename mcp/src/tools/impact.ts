import type { GraphStore } from "../store/GraphStore.js";
import { resolveTarget, type Selector } from "../profile/resolve.js";
import { computeImpact } from "../profile/impact.js";
import { federationIds } from "../store/federation.js";
import type { ToolResult } from "./readCypher.js";

export interface ImpactArgs {
  node_id?: string;
  file_path?: string;
  name?: string;
  depth?: number;
  federated?: boolean;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

/** Builds the impact tool handler bound to a store and repo.
 *
 *  Impact neighborhoods are CALLS-based only (see computeImpact). INSTANTIATES
 *  edges are captured in the committed graph for read_cypher/visualization but are
 *  intentionally NOT traversed here (recorded decision, matched across both
 *  backends) — instantiation sites are not treated as impact-bearing callers. */
export function makeImpact(store: GraphStore, repoId: string) {
  return async (args: ImpactArgs): Promise<ToolResult> => {
    const sel: Selector = {
      node_id: args.node_id,
      file_path: args.file_path,
      name: args.name,
    };

    if (!sel.node_id && !sel.name && !sel.file_path) {
      return {
        content: [{ type: "text", text: "provide one of: node_id, file_path+name, or name" }],
        isError: true,
      };
    }

    try {
      const repoIds = args.federated ? await federationIds(store, repoId) : [repoId];
      const resolved = await resolveTarget(store, repoIds, sel);

      if (resolved.kind === "not_found") {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "target not found" }) }],
          isError: true,
        };
      }

      if (resolved.kind === "candidates") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ambiguous: true,
                candidates: resolved.candidates.map((c) => ({
                  id: c.id,
                  name: c.qualified_name,
                  file_path: c.file_path,
                  repo_id: c.repo_id,
                })),
              }),
            },
          ],
        };
      }

      const target = resolved.target;
      const depth = clamp(args.depth ?? 3, 1, 5);
      const result = await computeImpact(
        store,
        repoIds,
        target.id,
        target.qualified_name,
        target.file_path,
        { depth, maxNodes: 500 },
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
  };
}
