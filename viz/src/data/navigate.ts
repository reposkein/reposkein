/** Keyboard navigation — pure & deterministic neighbor selection (design §P4,
 *  reworked for Astrolabe V4 §5).
 *
 *  With a node selected, the arrow keys (or Tab / ⇧Tab) hop to a CONNECTED
 *  neighbor. Two things about V3's version made that hop feel arbitrary:
 *
 *   1. NEIGHBOURS WERE SORTED LEXICOGRAPHICALLY. `a.ts#zulu` came after
 *      `a.ts#alpha` because of its name, not because of anything the reader
 *      could see on screen. "Next" therefore meant "next alphabetically", which
 *      is invisible in a spatial view. Neighbours are now RANKED: by how much
 *      the edge means (type, then resolution/confidence), then by how close the
 *      node is in the layout, with the id as the final tiebreak so the whole
 *      order stays deterministic.
 *
 *   2. THERE WAS NO ANCHOR. `pickNeighbor` took an optional `from`, but the
 *      caller never passed one, so hopping A→B and then pressing the opposite
 *      arrow walked B's own ring instead of returning to A — the reader lost
 *      their place with the very gesture meant to undo the hop. `nextHop`
 *      threads a `HopMemory` through, so the inverse direction always returns
 *      to the anchor, and repeating the SAME direction continues past it rather
 *      than ping-ponging A↔B.
 *
 *  Everything here is pure: same model + same memory + same direction → same
 *  pick, no module state. */

import type { DrawEdge } from "./model";

/** The layout slice ranking needs: where nodes are, and how to find a node's
 *  layout slot. Structurally a subset of `ClientModel`, declared narrowly so
 *  tests can hand over a literal. */
export interface HopModel {
  drawEdges: DrawEdge[];
  positions: Float32Array;
  indexByKey: Map<string, number>;
  clusterOfNode: Map<string, string>;
}

export type HopDir = "next" | "prev";

/** Where the last hop came from, so the inverse direction can undo it.
 *  `dir` is the direction that PRODUCED `to` from `from`. */
export interface HopMemory {
  from: string;
  to: string;
  dir: HopDir;
}

/** Relationship weight: how strong a claim this edge type makes about "these
 *  two things are related". CALLS is the spine of the graph — a call is a fact
 *  about behaviour — so it ranks first; the type hierarchy next; IMPORTS last,
 *  because a file-level import says the least about any particular symbol.
 *  Unknown types sort after all known ones (0) but before nothing. */
const TYPE_WEIGHT: Record<string, number> = {
  CALLS: 5,
  INHERITS: 4,
  IMPLEMENTS: 4,
  INSTANTIATES: 3,
  IMPORTS: 2,
};

/** How much to trust the edge exists at all. An `ambiguous` edge is the
 *  resolver guessing, and hopping along a guess before hopping along a fact
 *  would make the arrow keys feel unreliable in exactly the graphs where
 *  reliability matters most. */
const RESOLUTION_WEIGHT: Record<DrawEdge["resolution"], number> = {
  exact: 2,
  name_match: 1,
  ambiguous: 0,
};

function edgeScore(e: DrawEdge): number {
  const type = TYPE_WEIGHT[e.type] ?? 0;
  const resolution = RESOLUTION_WEIGHT[e.resolution] ?? 0;
  // Type dominates, resolution breaks ties within a type, confidence is the
  // fine-grained tiebreak inside that. Scaled so each tier can't outrank the
  // one above it: confidence is in [0,1].
  return type * 100 + resolution * 10 + Math.min(Math.max(e.confidence, 0), 1);
}

/** Squared world distance between two node ids, via their layout slots. Squared
 *  because only the ORDER matters and a sqrt per comparison is waste. Returns
 *  Infinity when either node has no layout slot, which sorts it last rather
 *  than pretending it sits at the origin. */
function distanceSq(model: HopModel, a: string, b: string): number {
  const ka = model.clusterOfNode.get(a) ?? a;
  const kb = model.clusterOfNode.get(b) ?? b;
  const ia = model.indexByKey.get(ka);
  const ib = model.indexByKey.get(kb);
  if (ia === undefined || ib === undefined) return Infinity;
  const dx = model.positions[ia * 3]! - model.positions[ib * 3]!;
  const dy = model.positions[ia * 3 + 1]! - model.positions[ib * 3 + 1]!;
  const dz = model.positions[ia * 3 + 2]! - model.positions[ib * 3 + 2]!;
  return dx * dx + dy * dy + dz * dz;
}

/** The sorted, de-duplicated set of nodes connected to `nodeId` over any
 *  relationship edge (both directions). Pure & deterministic.
 *
 *  Kept as the lexicographic set it always was: several callers (and the
 *  Inspector's incident-edge list) want "the neighbours, in a stable order"
 *  without the layout. Ranking is `rankedNeighbors` below. */
export function neighborsOf(edges: DrawEdge[], nodeId: string): string[] {
  const set = new Set<string>();
  for (const e of edges) {
    if (e.from === nodeId && e.to !== nodeId) set.add(e.to);
    else if (e.to === nodeId && e.from !== nodeId) set.add(e.from);
  }
  return [...set].sort();
}

/** The hop ring: `nodeId`'s neighbours ordered by strongest edge first, then
 *  nearest in the layout, then id. Pure & deterministic — the id tiebreak
 *  guarantees a total order even for co-located nodes joined by equal edges.
 *
 *  When a node is reachable over several edges, the STRONGEST one represents it
 *  (a symbol that both calls and imports another is primarily a caller). */
export function rankedNeighbors(model: HopModel, nodeId: string): string[] {
  const best = new Map<string, number>();
  for (const e of model.drawEdges) {
    let other: string | null = null;
    if (e.from === nodeId && e.to !== nodeId) other = e.to;
    else if (e.to === nodeId && e.from !== nodeId) other = e.from;
    if (other === null) continue;
    const score = edgeScore(e);
    const prev = best.get(other);
    if (prev === undefined || score > prev) best.set(other, score);
  }
  if (best.size === 0) return [];

  const dist = new Map<string, number>();
  for (const id of best.keys()) dist.set(id, distanceSq(model, nodeId, id));

  return [...best.keys()].sort((a, b) => {
    const byScore = best.get(b)! - best.get(a)!; // strongest first
    if (byScore !== 0) return byScore;
    const byDist = dist.get(a)! - dist.get(b)!; // nearest first
    if (byDist !== 0) return byDist;
    return a < b ? -1 : a > b ? 1 : 0; // total order, always
  });
}

/** Pick the neighbor to hop to from `current`, given a direction. Returns null
 *  when the node has no neighbors. Deterministic: identical inputs → identical
 *  pick. With no anchor, "next" lands on the highest-ranked neighbor and "prev"
 *  on the lowest.
 *
 *  @param model    the graph + layout (`ClientModel` satisfies `HopModel`).
 *  @param current  the currently-selected node id.
 *  @param dir      "next" | "prev".
 *  @param from     optional id we are stepping FROM within the neighbor ring
 *                  (defaults to `current`), so repeated hops cycle predictably.
 */
export function pickNeighbor(
  model: HopModel,
  current: string,
  dir: HopDir,
  from?: string,
): string | null {
  const neighbors = rankedNeighbors(model, current);
  if (neighbors.length === 0) return null;
  const anchor = from ?? current;
  const idx = neighbors.indexOf(anchor); // -1 when the anchor isn't a neighbor
  const n = neighbors.length;
  if (dir === "next") {
    return neighbors[idx === -1 ? 0 : (idx + 1) % n]!;
  }
  return neighbors[idx === -1 ? n - 1 : (idx - 1 + n) % n]!;
}

/** The result of one hop: where to go, and the memory to carry into the next. */
export interface Hop {
  id: string;
  memory: HopMemory;
}

const INVERSE: Record<HopDir, HopDir> = { next: "prev", prev: "next" };

/** ANCHOR-AWARE HOP (V4 §5). Given where we are, which way the reader pressed,
 *  and how we got here, decide where to land.
 *
 *  Two rules, in order:
 *
 *   1. UNDO. If the last hop brought us here and the reader pressed the
 *      OPPOSITE direction, go back to the anchor. Without this, ArrowRight then
 *      ArrowLeft walked the new node's own ring — so the gesture that obviously
 *      means "never mind" moved the reader somewhere third.
 *   2. CONTINUE. Otherwise walk `current`'s ranked ring, stepping from the
 *      anchor when we have one (so pressing the same direction twice advances
 *      past where we came from instead of bouncing back to it).
 *
 *  Returns null when there is nowhere to go. Pure.
 */
export function nextHop(
  model: HopModel,
  current: string,
  dir: HopDir,
  memory: HopMemory | null,
): Hop | null {
  const returning =
    memory !== null && memory.to === current && dir === INVERSE[memory.dir];
  if (returning) {
    return { id: memory.from, memory: { from: current, to: memory.from, dir } };
  }
  // Step from the anchor when this memory describes how we reached `current`;
  // otherwise the anchor is stale (the selection moved by some other means) and
  // the ring is walked from `current` itself.
  const anchor = memory !== null && memory.to === current ? memory.from : undefined;
  const id = pickNeighbor(model, current, dir, anchor);
  if (id === null) return null;
  return { id, memory: { from: current, to: id, dir } };
}
