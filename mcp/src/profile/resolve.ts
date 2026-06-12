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

/** Resolves a target: id → exact path#name → fuzzy name. Returns candidates
 *  (never guesses) when a name matches more than one node (PRD §7.4). */
export async function resolveTarget(
  store: GraphStore,
  repo: string,
  sel: Selector
): Promise<ResolveResult> {
  if (sel.node_id) {
    const node = await store.getNode(repo, sel.node_id);
    return node ? { kind: "found", target: node } : { kind: "not_found" };
  }
  if (sel.file_path && sel.name) {
    return fromRows(await store.resolveByPathAndName(repo, sel.file_path, sel.name));
  }
  if (sel.name) {
    return fromRows(await store.resolveByName(repo, sel.name));
  }
  return { kind: "not_found" };
}
