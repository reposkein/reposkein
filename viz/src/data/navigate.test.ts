import { describe, it, expect } from "vitest";
import {
  neighborsOf,
  nextHop,
  pickNeighbor,
  rankedNeighbors,
  type HopMemory,
  type HopModel,
} from "./navigate";
import type { DrawEdge } from "./model";

function edge(
  from: string,
  to: string,
  type = "CALLS",
  resolution: DrawEdge["resolution"] = "exact",
  confidence = 1,
): DrawEdge {
  return { from, to, type, resolution, confidence, crossRepo: false };
}

/** A HopModel over a hand-placed layout. `at` gives each id a world position;
 *  anything absent has no layout slot (and so sorts last on distance). */
function model(edges: DrawEdge[], at: Record<string, [number, number, number]> = {}): HopModel {
  const ids = Object.keys(at);
  const positions = new Float32Array(ids.length * 3);
  const indexByKey = new Map<string, number>();
  ids.forEach((id, i) => {
    indexByKey.set(id, i);
    positions[i * 3] = at[id]![0];
    positions[i * 3 + 1] = at[id]![1];
    positions[i * 3 + 2] = at[id]![2];
  });
  return { drawEdges: edges, positions, indexByKey, clusterOfNode: new Map() };
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

/** RANKING (V4 §5). V3 sorted neighbours lexicographically, so "next" meant
 *  "next alphabetically" — invisible in a spatial view. */
describe("rankedNeighbors", () => {
  it("puts the stronger RELATIONSHIP first, regardless of name", () => {
    // `zulu` is called; `alpha` is merely imported. A call says more.
    const m = model([edge("n", "zulu", "CALLS"), edge("n", "alpha", "IMPORTS")]);
    expect(rankedNeighbors(m, "n")).toEqual(["zulu", "alpha"]);
    // Lexicographic order would have been the reverse.
    expect(neighborsOf(m.drawEdges, "n")).toEqual(["alpha", "zulu"]);
  });

  it("ranks the type hierarchy above imports and below calls", () => {
    const m = model([
      edge("n", "imported", "IMPORTS"),
      edge("n", "called", "CALLS"),
      edge("n", "base", "INHERITS"),
    ]);
    expect(rankedNeighbors(m, "n")).toEqual(["called", "base", "imported"]);
  });

  it("prefers a RESOLVED edge over a guessed one of the same type", () => {
    const m = model([
      edge("n", "guess", "CALLS", "ambiguous", 0.4),
      edge("n", "fact", "CALLS", "exact", 1),
    ]);
    expect(rankedNeighbors(m, "n")).toEqual(["fact", "guess"]);
  });

  it("breaks a tie by SPATIAL proximity — nearest first", () => {
    const m = model(
      [edge("n", "far", "CALLS"), edge("n", "near", "CALLS")],
      { n: [0, 0, 0], near: [1, 0, 0], far: [100, 0, 0] },
    );
    expect(rankedNeighbors(m, "n")).toEqual(["near", "far"]);
  });

  it("represents a multiply-connected neighbor by its STRONGEST edge", () => {
    // `both` is imported AND called; the call is what ranks it.
    const m = model([
      edge("n", "both", "IMPORTS"),
      edge("n", "both", "CALLS"),
      edge("n", "typed", "INHERITS"),
    ]);
    expect(rankedNeighbors(m, "n")).toEqual(["both", "typed"]);
  });

  it("falls back to the id for a total order, so co-located equals never wobble", () => {
    const m = model(
      [edge("n", "b", "CALLS"), edge("n", "a", "CALLS")],
      { n: [0, 0, 0], a: [1, 0, 0], b: [1, 0, 0] },
    );
    expect(rankedNeighbors(m, "n")).toEqual(["a", "b"]);
    // Deterministic across calls.
    expect(rankedNeighbors(m, "n")).toEqual(rankedNeighbors(m, "n"));
  });

  it("sorts a node with no layout slot last rather than at the origin", () => {
    const m = model(
      [edge("n", "placed", "CALLS"), edge("n", "unplaced", "CALLS")],
      { n: [0, 0, 0], placed: [50, 0, 0] },
    );
    expect(rankedNeighbors(m, "n")).toEqual(["placed", "unplaced"]);
  });

  it("returns empty for an isolated node", () => {
    expect(rankedNeighbors(model([edge("x", "y")]), "n")).toEqual([]);
  });
});

describe("pickNeighbor (deterministic keyboard hopping)", () => {
  // Equal edges, distinct positions: the ring is a,b,c by distance.
  const m = model(
    [edge("n", "b"), edge("n", "a"), edge("c", "n")],
    { n: [0, 0, 0], a: [1, 0, 0], b: [2, 0, 0], c: [3, 0, 0] },
  );

  it("returns null when the node has no neighbors", () => {
    expect(pickNeighbor(model([edge("x", "y")]), "a", "next")).toBeNull();
  });

  it("'next' from the node itself lands on the highest-ranked neighbor", () => {
    expect(pickNeighbor(m, "n", "next")).toBe("a");
  });

  it("'prev' from the node itself lands on the lowest-ranked neighbor", () => {
    expect(pickNeighbor(m, "n", "prev")).toBe("c");
  });

  it("steps forward through the ring and wraps", () => {
    expect(pickNeighbor(m, "n", "next", "a")).toBe("b");
    expect(pickNeighbor(m, "n", "next", "b")).toBe("c");
    expect(pickNeighbor(m, "n", "next", "c")).toBe("a"); // wrap
  });

  it("steps backward through the ring and wraps", () => {
    expect(pickNeighbor(m, "n", "prev", "c")).toBe("b");
    expect(pickNeighbor(m, "n", "prev", "b")).toBe("a");
    expect(pickNeighbor(m, "n", "prev", "a")).toBe("c"); // wrap
  });

  it("is deterministic: identical inputs → identical pick", () => {
    expect(pickNeighbor(m, "n", "next", "a")).toBe(pickNeighbor(m, "n", "next", "a"));
  });
});

/** ANCHOR-AWARE HOP (V4 §5). V3's `pickNeighbor` took an optional `from`, but
 *  the caller never passed one — so ArrowRight then ArrowLeft walked the NEW
 *  node's ring and the reader lost their place with the very gesture meant to
 *  undo the hop. */
describe("nextHop — the anchor round trip", () => {
  // A <-> B, and B also connects to Z, so B's own ring has somewhere else to go.
  const m = model(
    [edge("A", "B"), edge("B", "Z")],
    { A: [0, 0, 0], B: [10, 0, 0], Z: [20, 0, 0] },
  );

  it("ArrowRight then ArrowLeft returns to the ANCHOR, not to B's own ring", () => {
    const first = nextHop(m, "A", "next", null);
    expect(first!.id).toBe("B");
    expect(first!.memory).toEqual({ from: "A", to: "B", dir: "next" });

    const back = nextHop(m, "B", "prev", first!.memory);
    expect(back!.id).toBe("A");
    // …and the memory flips, so pressing ArrowRight again re-does the hop.
    expect(back!.memory).toEqual({ from: "B", to: "A", dir: "prev" });
    const redo = nextHop(m, "A", "next", back!.memory);
    expect(redo!.id).toBe("B");
  });

  it("continuing the SAME direction walks past the anchor — no A↔B ping-pong", () => {
    const first = nextHop(m, "A", "next", null);
    expect(first!.id).toBe("B");
    // From B, "next" steps from the anchor A within B's ring {A, Z} → Z.
    const second = nextHop(m, "B", "next", first!.memory);
    expect(second!.id).toBe("Z");
    expect(second!.id).not.toBe("A");
  });

  it("ignores a STALE memory: one whose `to` is not the current selection", () => {
    const stale: HopMemory = { from: "A", to: "B", dir: "next" };
    // The reader clicked A directly, so we are at A with B's memory still around.
    const hop = nextHop(m, "A", "prev", stale);
    // A's only neighbor is B — the point is that it did not treat `A` as the
    // anchor-return target and it produced a fresh memory.
    expect(hop!.id).toBe("B");
    expect(hop!.memory).toEqual({ from: "A", to: "B", dir: "prev" });
  });

  it("works with no memory at all (the first hop of a session)", () => {
    const hop = nextHop(m, "A", "next", null);
    expect(hop).toEqual({ id: "B", memory: { from: "A", to: "B", dir: "next" } });
  });

  it("returns null with nowhere to go", () => {
    expect(nextHop(model([edge("x", "y")]), "n", "next", null)).toBeNull();
  });

  it("treats Tab/⇧Tab and the arrows identically — direction is all it sees", () => {
    expect(nextHop(m, "A", "next", null)!.id).toBe(nextHop(m, "A", "next", null)!.id);
  });

  it("a three-node ring: hop out, hop back, and land where you started", () => {
    const ring = model(
      [edge("n", "a"), edge("n", "b"), edge("n", "c")],
      { n: [0, 0, 0], a: [1, 0, 0], b: [2, 0, 0], c: [3, 0, 0] },
    );
    const out = nextHop(ring, "n", "next", null);
    expect(out!.id).toBe("a");
    const home = nextHop(ring, "a", "prev", out!.memory);
    expect(home!.id).toBe("n");
  });
});
