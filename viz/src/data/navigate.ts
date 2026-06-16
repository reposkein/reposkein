/** Keyboard navigation — pure & deterministic neighbor selection (design §P4).
 *
 *  With a node selected, the arrow keys (or Tab / Shift-Tab) hop to a CONNECTED
 *  neighbor. To keep the hop deterministic and repeatable, neighbors are the
 *  DISTINCT node ids reachable over any relationship edge (out OR in), SORTED
 *  lexicographically. "next" advances one position (wrapping); "prev" steps
 *  back. The starting position is the current node's own index in that sorted
 *  neighbor list if present, else -1 so "next" lands on the first neighbor.
 */

import type { DrawEdge } from "./model";

/** The sorted, de-duplicated set of nodes connected to `nodeId` over any
 *  relationship edge (both directions). Pure & deterministic. */
export function neighborsOf(edges: DrawEdge[], nodeId: string): string[] {
  const set = new Set<string>();
  for (const e of edges) {
    if (e.from === nodeId && e.to !== nodeId) set.add(e.to);
    else if (e.to === nodeId && e.from !== nodeId) set.add(e.from);
  }
  return [...set].sort();
}

/** Pick the neighbor to hop to from `current`, given a direction. Returns null
 *  when the node has no neighbors. Deterministic: identical inputs → identical
 *  pick. With nothing previously visited, "next" lands on the first (sorted)
 *  neighbor and "prev" on the last.
 *
 *  @param edges    the relationship edges (model.drawEdges).
 *  @param current  the currently-selected node id.
 *  @param dir      "next" | "prev".
 *  @param from     optional id we are stepping FROM within the neighbor ring
 *                  (defaults to `current`), so repeated hops cycle predictably.
 */
export function pickNeighbor(
  edges: DrawEdge[],
  current: string,
  dir: "next" | "prev",
  from?: string,
): string | null {
  const neighbors = neighborsOf(edges, current);
  if (neighbors.length === 0) return null;
  const anchor = from ?? current;
  const idx = neighbors.indexOf(anchor); // -1 when the anchor isn't a neighbor
  const n = neighbors.length;
  if (dir === "next") {
    return neighbors[idx === -1 ? 0 : (idx + 1) % n]!;
  }
  return neighbors[idx === -1 ? n - 1 : (idx - 1 + n) % n]!;
}
