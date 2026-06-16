import { describe, it, expect } from "vitest";
import { constellationMst, type ConstellationPoint } from "./constellation";

function pt(key: string, x: number, y: number, z = 0): ConstellationPoint {
  return { key, x, y, z };
}

describe("constellation MST derivation", () => {
  it("returns no edges for fewer than two points", () => {
    expect(constellationMst([])).toEqual([]);
    expect(constellationMst([pt("a", 0, 0)])).toEqual([]);
  });

  it("connects n points with exactly n-1 edges (a spanning tree)", () => {
    const pts = [
      pt("a", 0, 0),
      pt("b", 1, 0),
      pt("c", 2, 0),
      pt("d", 0, 1),
      pt("e", 5, 5),
    ];
    const edges = constellationMst(pts);
    expect(edges.length).toBe(pts.length - 1);
  });

  it("is deterministic: identical input yields identical output", () => {
    const make = (): ConstellationPoint[] => [
      pt("a", 0, 0, 0),
      pt("b", 3, 1, -2),
      pt("c", -1, 4, 1),
      pt("d", 2, 2, 2),
    ];
    expect(constellationMst(make())).toEqual(constellationMst(make()));
  });

  it("output is invariant to input order (canonical, index-stable on a colinear chain)", () => {
    // A colinear chain 0-1-2-3 has a unique MST (consecutive neighbors).
    const pts = [pt("a", 0, 0), pt("b", 1, 0), pt("c", 2, 0), pt("d", 3, 0)];
    const edges = constellationMst(pts);
    expect(edges).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("picks the nearest-neighbor connection (a square's MST is three sides)", () => {
    const pts = [pt("a", 0, 0), pt("b", 1, 0), pt("c", 1, 1), pt("d", 0, 1)];
    const edges = constellationMst(pts);
    expect(edges.length).toBe(3);
    // Every emitted edge is a unit-length side (no diagonal of length sqrt(2)).
    for (const [i, j] of edges) {
      const dx = pts[i]!.x - pts[j]!.x;
      const dy = pts[i]!.y - pts[j]!.y;
      expect(Math.hypot(dx, dy)).toBeCloseTo(1, 6);
    }
  });
});
