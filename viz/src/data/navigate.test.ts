import { describe, it, expect } from "vitest";
import { neighborsOf, pickNeighbor } from "./navigate";
import type { DrawEdge } from "./model";

function edge(from: string, to: string, type = "CALLS"): DrawEdge {
  return { from, to, type, resolution: "exact", confidence: 1, crossRepo: false };
}

describe("neighborsOf", () => {
  it("collects both out- and in-edge neighbors, sorted + de-duplicated", () => {
    // a -> c, a -> b, d -> a, plus a duplicate edge a -> b.
    const edges = [edge("a", "c"), edge("a", "b"), edge("d", "a"), edge("a", "b")];
    expect(neighborsOf(edges, "a")).toEqual(["b", "c", "d"]);
  });

  it("excludes self-loops", () => {
    expect(neighborsOf([edge("a", "a")], "a")).toEqual([]);
  });

  it("returns empty for an isolated node", () => {
    expect(neighborsOf([edge("x", "y")], "a")).toEqual([]);
  });
});

describe("pickNeighbor (deterministic keyboard hopping)", () => {
  const edges = [edge("n", "b"), edge("n", "a"), edge("c", "n")]; // neighbors of n: a,b,c

  it("returns null when the node has no neighbors", () => {
    expect(pickNeighbor([edge("x", "y")], "a", "next")).toBeNull();
  });

  it("'next' from the node itself lands on the first sorted neighbor", () => {
    expect(pickNeighbor(edges, "n", "next")).toBe("a");
  });

  it("'prev' from the node itself lands on the last sorted neighbor", () => {
    expect(pickNeighbor(edges, "n", "prev")).toBe("c");
  });

  it("steps forward through the sorted ring and wraps", () => {
    expect(pickNeighbor(edges, "n", "next", "a")).toBe("b");
    expect(pickNeighbor(edges, "n", "next", "b")).toBe("c");
    expect(pickNeighbor(edges, "n", "next", "c")).toBe("a"); // wrap
  });

  it("steps backward through the sorted ring and wraps", () => {
    expect(pickNeighbor(edges, "n", "prev", "c")).toBe("b");
    expect(pickNeighbor(edges, "n", "prev", "b")).toBe("a");
    expect(pickNeighbor(edges, "n", "prev", "a")).toBe("c"); // wrap
  });

  it("is deterministic: identical inputs → identical pick", () => {
    expect(pickNeighbor(edges, "n", "next", "a")).toBe(pickNeighbor(edges, "n", "next", "a"));
  });
});
