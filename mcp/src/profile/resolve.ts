import type { GraphStore } from "../store/GraphStore.js";
import type { ResolveResult, TargetRow } from "./types.js";

export interface Selector {
  node_id?: string;
  file_path?: string;
  name?: string;
}

function fromRows(rows: TargetRow[]): ResolveResult {
  if (rows.length === 1) return { kind: "found", target: rows[0]! };
  if (rows.length > 1) return { kind: "candidates", candidates: rows };
  return { kind: "not_found" };
}

/** Resolves a target across one or more repos: id → exact path#name → fuzzy
 *  name. Returns candidates (never guesses) when a name is ambiguous (§7.4). */
export async function resolveTarget(
  store: GraphStore,
  repos: string | string[],
  sel: Selector
): Promise<ResolveResult> {
  const repoIds = Array.isArray(repos) ? repos : [repos];
  if (sel.node_id) {
    const node = await store.getNode(repoIds, sel.node_id);
    return node ? { kind: "found", target: node } : { kind: "not_found" };
  }
  if (sel.file_path && sel.name) {
    return fromRows(await store.resolveByPathAndName(repoIds, sel.file_path, sel.name));
  }
  if (sel.name) {
    return fromRows(await store.resolveByName(repoIds, sel.name));
  }
  return { kind: "not_found" };
}
