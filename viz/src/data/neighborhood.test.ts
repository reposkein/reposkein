import { describe, it, expect } from "vitest";
import { computeNeighborhood, clampDepth, MAX_FOCUS_DEPTH, MIN_FOCUS_DEPTH } from "./neighborhood";
import type { DrawEdge } from "./model";

function edge(from: string, to: string, type = "CALLS"): DrawEdge {
  return { from, to, type, resolution: "exact", confidence: 1, crossRepo: false };
}

describe("clampDepth", () => {
  it("clamps to [1,3] and rounds", () => {
    expect(clampDepth(0)).toBe(MIN_FOCUS_DEPTH);
    expect(clampDepth(-5)).toBe(MIN_FOCUS_DEPTH);
    expect(clampDepth(2)).toBe(2);
    expect(clampDepth(99)).toBe(MAX_FOCUS_DEPTH);
    expect(clampDepth(2.4)).toBe(2);
    expect(clampDepth(2.6)).toBe(3);
  });
});

describe("computeNeighborhood (bidirectional, depth-bounded BFS)", () => {
  it("includes the source itself", () => {
    const r = computeNeighborhood([], "a", 2);
    expect(r.nodes.has("a")).toBe(true);
    expect(r.nodes.size).toBe(1);
  });

  it("traverses BOTH out- and in-edges (bidirectional)", () => {
    // a -> b  and  c -> a : both b (out) and c (in) are 1-hop from a.
    const edges = [edge("a", "b"), edge("c", "a")];
    const r = computeNeighborhood(edges, "a", 1);
    expect([...r.nodes].sort()).toEqual(["a", "b", "c"]);
  });

  it("respects the depth bound exactly", () => {
    // chain: a -> b -> c -> d -> e
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")];
    expect([...computeNeighborhood(edges, "a", 1).nodes].sort()).toEqual(["a", "b"]);
    expect([...computeNeighborhood(edges, "a", 2).nodes].sort()).toEqual(["a", "b", "c"]);
    expect([...computeNeighborhood(edges, "a", 3).nodes].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("explores undirected reach from a mid-chain node within depth", () => {
    // a -> b -> c ; from b at depth 1 we reach a (in) and c (out).
    const edges = [edge("a", "b"), edge("b", "c")];
    expect([...computeNeighborhood(edges, "b", 1).nodes].sort()).toEqual(["a", "b", "c"]);
  });

  it("honors an edge-type whitelist when provided", () => {
    // a -CALLS-> b , a -IMPORTS-> c. Whitelist CALLS only → c is excluded.
    const edges = [edge("a", "b", "CALLS"), edge("a", "c", "IMPORTS")];
    const r = computeNeighborhood(edges, "a", 1, new Set(["CALLS"]));
    expect([...r.nodes].sort()).toEqual(["a", "b"]);
  });

  it("follows all edge types when the whitelist is empty/omitted", () => {
    const edges = [edge("a", "b", "CALLS"), edge("a", "c", "IMPORTS")];
    expect([...computeNeighborhood(edges, "a", 1).nodes].sort()).toEqual(["a", "b", "c"]);
    expect([...computeNeighborhood(edges, "a", 1, new Set()).nodes].sort()).toEqual(["a", "b", "c"]);
  });

  it("handles cycles without looping forever", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    const r = computeNeighborhood(edges, "a", 5);
    expect([...r.nodes].sort()).toEqual(["a", "b", "c"]);
    expect(r.depth).toBe(MAX_FOCUS_DEPTH); // depth clamped to 3
  });

  it("is deterministic: identical inputs → identical membership", () => {
    const edges = [edge("a", "b"), edge("c", "a"), edge("b", "d")];
    const r1 = computeNeighborhood(edges, "a", 2);
    const r2 = computeNeighborhood(edges, "a", 2);
    expect([...r1.nodes].sort()).toEqual([...r2.nodes].sort());
  });
});
