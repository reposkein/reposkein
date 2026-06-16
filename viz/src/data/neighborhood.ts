/** Neighborhood focus — pure & deterministic (design §P2).
 *
 *  "Show me this symbol and everything it touches": a BFS over BOTH out- and
 *  in-edges (the full relationship graph, optionally gated to a lens's edge
 *  types) to a bounded depth N. Distinct from the Impact overlay, which is
 *  callers-only (reverse-CALLS) and unbounded — this is BIDIRECTIONAL and
 *  DEPTH-BOUNDED, the get_context_profile analogue.
 *
 *  The result is the set of node ids within N hops of the source (INCLUDING
 *  the source itself), so the scene can keep that region bright and dim/hide
 *  everything else. Deterministic: membership is a set, independent of edge
 *  iteration order; we only read drawEdges (already sorted upstream).
 */

import type { DrawEdge } from "./model";

export interface NeighborhoodResult {
  /** The node the neighborhood was computed for. */
  sourceId: string;
  /** BFS depth used (1..MAX_FOCUS_DEPTH). */
  depth: number;
  /** Node ids within `depth` hops over BOTH directions, INCLUDING the source. */
  nodes: Set<string>;
}

/** Depth bounds for the focus depth control (inclusive). */
export const MIN_FOCUS_DEPTH = 1;
export const MAX_FOCUS_DEPTH = 3;
export const DEFAULT_FOCUS_DEPTH = 2;

/** Clamp an arbitrary number to the allowed focus-depth range (integer). */
export function clampDepth(d: number): number {
  return Math.max(MIN_FOCUS_DEPTH, Math.min(MAX_FOCUS_DEPTH, Math.round(d)));
}

/** Compute the bidirectional, depth-bounded neighborhood of `sourceId`.
 *
 *  @param edges       the relationship edges (model.drawEdges).
 *  @param sourceId    the node to expand around.
 *  @param depth       hop limit (clamped to [1,3]).
 *  @param edgeTypes   optional whitelist of edge types to traverse (a lens's
 *                     active types). When omitted, ALL edge types are followed.
 *
 *  Returns a set INCLUDING the source. Pure: same inputs → identical set.
 */
export function computeNeighborhood(
  edges: DrawEdge[],
  sourceId: string,
  depth: number,
  edgeTypes?: Set<string>,
): NeighborhoodResult {
  const d = clampDepth(depth);

  // Undirected adjacency over the (optionally type-gated) relationship edges.
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  };
  for (const e of edges) {
    if (edgeTypes && edgeTypes.size > 0 && !edgeTypes.has(e.type)) continue;
    link(e.from, e.to);
    link(e.to, e.from);
  }

  // BFS to depth d. `nodes` carries the visited set (incl. source); we expand
  // a frontier level-by-level so the hop bound is exact.
  const nodes = new Set<string>([sourceId]);
  let frontier: string[] = [sourceId];
  for (let hop = 0; hop < d && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const neighbors = adj.get(cur);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (nodes.has(nb)) continue;
        nodes.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }

  return { sourceId, depth: d, nodes };
}
