/** Impact analysis — pure & deterministic.
 *
 *  Given a selected node, computes its transitive CALLERS by BFS over
 *  REVERSE-CALLS edges (i.e. who calls it, who calls those, …). The
 *  "covering tests" are the subset of those callers that classify as test
 *  code (so you can see which tests exercise the selected node, directly or
 *  transitively).
 *
 *  Only CALLS edges participate — IMPORTS/INHERITS/etc. are structural and
 *  don't represent runtime reachability. The source node itself is NOT counted
 *  as impacted (it's the thing being changed).
 */

import type { ClientModel } from "./clientModel";
import { isTestNode } from "./classify";

export interface ImpactResult {
  /** The node the impact was computed for. */
  sourceId: string;
  /** Transitive callers (reverse-CALLS), EXCLUDING the source. */
  impacted: Set<string>;
  /** Subset of `impacted` classified as test code. */
  coveringTests: Set<string>;
}

/** Transitive reverse-CALLS callers of `sourceId`, plus covering tests.
 *  Deterministic: edge iteration follows the (already-sorted) drawEdges order
 *  and the result is a set, so order doesn't affect membership. */
export function computeImpact(model: ClientModel, sourceId: string): ImpactResult {
  // Build a reverse-CALLS adjacency: callee -> [callers].
  const callers = new Map<string, string[]>();
  for (const e of model.drawEdges) {
    if (e.type !== "CALLS") continue;
    const list = callers.get(e.to);
    if (list) list.push(e.from);
    else callers.set(e.to, [e.from]);
  }

  const impacted = new Set<string>();
  const queue: string[] = [sourceId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const incoming = callers.get(cur);
    if (!incoming) continue;
    for (const caller of incoming) {
      if (caller === sourceId || impacted.has(caller)) continue;
      impacted.add(caller);
      queue.push(caller);
    }
  }

  const coveringTests = new Set<string>();
  for (const id of impacted) {
    const rec = model.records.get(id);
    if (rec && isTestNode(rec)) coveringTests.add(id);
  }

  return { sourceId, impacted, coveringTests };
}
