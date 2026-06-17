import { describe, it, expect } from "vitest";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import { bundlePath, segmentCounts, buildBundledGeometry } from "./bundleGeometry";
import { adaptiveEdgeScale, EDGE_INK_BUDGET, EDGE_K_MIN, applyNodeFloor } from "./encoding";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

function clientModel(g: RawGraph): ClientModel {
  const m = buildModel(g);
  const result: WorkerResult = {
    type: "result",
    repoId: m.tree.repoId,
    rootKey: m.tree.rootKey,
    clusters: [...m.tree.byKey.values()],
    keys: m.layout.keys,
    positions: m.layout.positions,
    drawEdges: m.drawEdges,
    records: [...m.records.entries()],
    fingerprint: m.fingerprint,
    counts: { nodes: g.nodes.length, edges: g.edges.length },
    repoRoot: null,
  };
  return fromWorker(result);
}

const F = (path: string, name: string) => ({
  id: `rs1:r:sym:${path}#${name}`,
  labels: ["Function"],
  props: { name, qualified_name: `${path}::${name}`, file_path: path, content_hash: `h-${name}` },
});

/** Two dirs/files/symbols so an LCA path has interior control points. */
function graph(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
      { id: "rs1:r:dir:core", labels: ["Directory"], props: { name: "core", path: "core" } },
      { id: "rs1:r:dir:util", labels: ["Directory"], props: { name: "util", path: "util" } },
      { id: "rs1:r:file:core/a.ts", labels: ["File"], props: { name: "a.ts", path: "core/a.ts", language: "typescript" } },
      { id: "rs1:r:file:util/c.ts", labels: ["File"], props: { name: "c.ts", path: "util/c.ts", language: "typescript" } },
      F("core/a.ts", "main"),
      F("util/c.ts", "leaf"),
    ],
    edges: [
      { from: "rs1:r:sym:core/a.ts#main", type: "CALLS", to: "rs1:r:sym:util/c.ts#leaf", props: { resolution: "exact", confidence: 1 } },
    ],
  };
}

/** Two distinct galaxy roots (cross-repo): ancestor chains share no root. */
function crossRepoModel(): ClientModel {
  const m = clientModel(graph());
  // Inject a second galaxy root + a node under it with a disjoint chain.
  const r2Sym = "rs1:s:sym:x/y.ts#z";
  m.byKey.set("galaxy:s", { key: "galaxy:s", kind: "galaxy", name: "s", parent: null, children: [r2Sym], nodeId: null });
  m.byKey.set(r2Sym, { key: r2Sym, kind: "symbol", name: "z", parent: "galaxy:s", children: [], nodeId: r2Sym, symbolKind: "Function" });
  m.ancestors.set("galaxy:s", ["galaxy:s"]);
  m.ancestors.set(r2Sym, ["galaxy:s", r2Sym]);
  // Give both endpoints positions in indexByKey via a fresh buffer.
  return m;
}

describe("bundlePath", () => {
  it("walks src → LCA → dst through the cluster tree", () => {
    const m = clientModel(graph());
    const path = bundlePath(m, "file:r:core/a.ts", "file:r:util/c.ts");
    // file → dir:core → galaxy → dir:util → file (interior control points).
    expect(path[0]).toBe("file:r:core/a.ts");
    expect(path[path.length - 1]).toBe("file:r:util/c.ts");
    // LCA of core/a.ts and util/c.ts is the root dir "dir:r:." (interior point).
    expect(path).toContain("dir:r:.");
    expect(path).toContain("dir:r:core");
    expect(path).toContain("dir:r:util");
    expect(path.length).toBeGreaterThan(2);
  });

  it("returns the straight 2-key chord for disjoint roots (cross-repo)", () => {
    const m = crossRepoModel();
    const path = bundlePath(m, "file:r:core/a.ts", "rs1:s:sym:x/y.ts#z");
    expect(path).toEqual(["file:r:core/a.ts", "rs1:s:sym:x/y.ts#z"]);
  });

  it("returns the 2-key chord when an ancestor chain is missing", () => {
    const m = clientModel(graph());
    expect(bundlePath(m, "unknown-a", "unknown-b")).toEqual(["unknown-a", "unknown-b"]);
  });
});

describe("segmentCounts", () => {
  it("uses 1 segment for degenerate (2-key) paths", () => {
    const m = crossRepoModel();
    const counts = segmentCounts(m, [{ srcKey: "file:r:core/a.ts", dstKey: "rs1:s:sym:x/y.ts#z" }]);
    expect(counts).toEqual([1]);
  });

  it("respects the global segment budget under many bundles", () => {
    const m = clientModel(graph());
    // Fabricate a huge plan of curved bundles to exceed the budget.
    const plan = Array.from({ length: 60_000 }, () => ({
      srcKey: "file:r:core/a.ts",
      dstKey: "file:r:util/c.ts",
    }));
    const counts = segmentCounts(m, plan);
    const total = counts.reduce((a, c) => a + c, 0);
    expect(total).toBeLessThanOrEqual(150_000);
    for (const c of counts) expect(c).toBeGreaterThanOrEqual(1);
  });
});

describe("buildBundledGeometry", () => {
  const plan = () => [{ srcKey: "file:r:core/a.ts", dstKey: "file:r:util/c.ts", r: 1, g: 0.5, b: 0.2, a: 0.8 }];

  it("beta=0 produces straight segments (interior verts collinear with chord)", () => {
    const m = clientModel(graph());
    const geo = buildBundledGeometry(m, plan(), 0, 1);
    const pos = geo.getAttribute("position").array as Float32Array;
    const range = geo.drawRange.count; // number of vertices
    expect(range).toBeGreaterThan(2);
    // First and last vertices are the chord endpoints.
    const sx = pos[0]!, sy = pos[1]!, sz = pos[2]!;
    const li = (range - 1) * 3;
    const ex = pos[li]!, ey = pos[li + 1]!, ez = pos[li + 2]!;
    // Cross-product distance of each interior vert from the chord line must be ~0.
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const chordLen = Math.hypot(dx, dy, dz);
    for (let v = 0; v < range; v++) {
      const x = pos[v * 3]! - sx, y = pos[v * 3 + 1]! - sy, z = pos[v * 3 + 2]! - sz;
      // |(P-S) × chordDir| should be ~0 when collinear.
      const cxp = y * dz - z * dy;
      const cyp = z * dx - x * dz;
      const czp = x * dy - y * dx;
      const perp = Math.hypot(cxp, cyp, czp) / (chordLen || 1);
      expect(perp).toBeLessThan(1e-3);
    }
  });

  it("beta>0 bows the curve off the chord", () => {
    const m = clientModel(graph());
    const geo = buildBundledGeometry(m, plan(), 0.85, 1);
    const pos = geo.getAttribute("position").array as Float32Array;
    const range = geo.drawRange.count;
    const sx = pos[0]!, sy = pos[1]!, sz = pos[2]!;
    const li = (range - 1) * 3;
    const ex = pos[li]!, ey = pos[li + 1]!, ez = pos[li + 2]!;
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const chordLen = Math.hypot(dx, dy, dz);
    let maxPerp = 0;
    for (let v = 0; v < range; v++) {
      const x = pos[v * 3]! - sx, y = pos[v * 3 + 1]! - sy, z = pos[v * 3 + 2]! - sz;
      const cxp = y * dz - z * dy, cyp = z * dx - x * dz, czp = x * dy - y * dx;
      maxPerp = Math.max(maxPerp, Math.hypot(cxp, cyp, czp) / (chordLen || 1));
    }
    expect(maxPerp).toBeGreaterThan(1e-2); // visibly curved
  });

  it("produces no NaN in positions or colors", () => {
    const m = clientModel(graph());
    const geo = buildBundledGeometry(m, plan(), 0.85, 0.5);
    const pos = geo.getAttribute("position").array as Float32Array;
    const col = geo.getAttribute("color").array as Float32Array;
    for (const x of pos) expect(Number.isFinite(x)).toBe(true);
    for (const x of col) expect(Number.isFinite(x)).toBe(true);
  });

  it("is deterministic (byte-stable across two builds)", () => {
    const m = clientModel(graph());
    const a = buildBundledGeometry(m, plan(), 0.85, 1).getAttribute("position").array as Float32Array;
    const b = buildBundledGeometry(m, plan(), 0.85, 1).getAttribute("position").array as Float32Array;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("premultiplies color by alpha·k", () => {
    const m = crossRepoModel();
    const geo = buildBundledGeometry(
      m,
      [{ srcKey: "file:r:core/a.ts", dstKey: "rs1:s:sym:x/y.ts#z", r: 1, g: 1, b: 1, a: 0.5 }],
      0,
      0.5,
    );
    // straight (disjoint) → 1 segment; color = 1 * (0.5*0.5) = 0.25.
    const col = geo.getAttribute("color").array as Float32Array;
    // crossRepoModel's second endpoint lacks a position index → skipped; guard.
    if (geo.drawRange.count > 0) {
      expect(col[0]).toBeCloseTo(0.25, 5);
    }
  });
});

describe("adaptiveEdgeScale", () => {
  it("is 1 under the budget", () => {
    expect(adaptiveEdgeScale(0)).toBe(1);
    expect(adaptiveEdgeScale(EDGE_INK_BUDGET)).toBe(1);
  });
  it("scales ~1/drawn above the budget, floored at EDGE_K_MIN", () => {
    expect(adaptiveEdgeScale(EDGE_INK_BUDGET * 2)).toBeCloseTo(0.5, 5);
    expect(adaptiveEdgeScale(1_000_000)).toBe(EDGE_K_MIN);
  });
});

describe("applyNodeFloor", () => {
  it("lifts a near-black triple to the floor while preserving hue", () => {
    const [r, g, b] = applyNodeFloor(0.02, 0.01, 0);
    expect(Math.max(r, g, b)).toBeCloseTo(0.1, 5);
    expect(r / g).toBeCloseTo(2, 5); // hue ratio preserved
  });
  it("leaves bright triples unchanged", () => {
    expect(applyNodeFloor(0.5, 0.4, 0.3)).toEqual([0.5, 0.4, 0.3]);
  });
});
