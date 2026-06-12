import type { GraphStore } from "../store/GraphStore.js";
import { resolveTarget, type Selector } from "../profile/resolve.js";
import { assembleProfile } from "../profile/assemble.js";
import type { ToolResult } from "./readCypher.js";

export interface GetContextProfileArgs {
  node_id?: string;
  file_path?: string;
  name?: string;
  hops?: number;
}

export function makeGetContextProfile(store: GraphStore, repoId: string) {
  return async (args: GetContextProfileArgs): Promise<ToolResult> => {
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
    // Hard-cap hops at 2 (PRD §10.1).
    const hops: 1 | 2 = args.hops === 2 ? 2 : 1;
    try {
      const resolved = await resolveTarget(store, repoId, sel);
      if (resolved.kind === "not_found") {
        return { content: [{ type: "text", text: JSON.stringify({ error: "target not found" }) }], isError: true };
      }
      if (resolved.kind === "candidates") {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ambiguous: true,
              candidates: resolved.candidates.map((c) => ({ id: c.id, name: c.qualified_name, file_path: c.file_path })),
            }),
          }],
        };
      }
      const profile = await assembleProfile(store, repoId, resolved.target, hops);
      return { content: [{ type: "text", text: JSON.stringify(profile) }] };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  };
}
