import { describe, it, expect } from "vitest";
import {
  boundsOfXY,
  buildProjection,
  minimapToWorld,
  projectBounds,
  viewportHalfExtents,
  visibleXY,
  worldToMinimap,
} from "./minimap";
import { buildModel } from "../data/model";
import { fromWorker, visibleClusters, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

describe("minimap projection", () => {
  it("computes X/Y bounds, ignoring Z", () => {
    const pos = new Float32Array([
      -10, 5, 999, // x=-10, y=5
      20, -3, -999, // x=20,  y=-3
      0, 0, 0,
    ]);
    const b = projectBounds(pos);
    expect(b).toEqual({ minX: -10, maxX: 20, minY: -3, maxY: 5 });
  });

  it("returns a zero box at origin for empty input", () => {
    expect(projectBounds(new Float32Array([]))).toEqual({
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
    });
  });

  it("world↔minimap is an exact round-trip", () => {
    const b = { minX: -50, maxX: 50, minY: -30, maxY: 30 };
    const proj = buildProjection(b, 160, 120);
    for (const [x, y] of [
      [0, 0],
      [-50, 30],
      [50, -30],
      [12.5, -7.25],
    ] as const) {
      const { px, py } = worldToMinimap(proj, x, y);
      const back = minimapToWorld(proj, px, py);
      expect(back.x).toBeCloseTo(x, 5);
      expect(back.y).toBeCloseTo(y, 5);
    }
  });

  it("centers the bounds and keeps points inside the padded canvas", () => {
    const b = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
    const w = 160;
    const h = 120;
    const proj = buildProjection(b, w, h, 6);
    // Center of bounds maps to canvas center.
    const c = worldToMinimap(proj, 0, 0);
    expect(c.px).toBeCloseTo(w / 2, 5);
    expect(c.py).toBeCloseTo(h / 2, 5);
    // All four corners stay within [pad, size-pad] on the limiting axis.
    for (const [x, y] of [
      [-100, -100],
      [100, 100],
      [-100, 100],
      [100, -100],
    ] as const) {
      const { px, py } = worldToMinimap(proj, x, y);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(w);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(h);
    }
  });

  it("uses a uniform scale (preserves aspect)", () => {
    // Wide bounds: scale limited by X; both axes share one scale.
    const proj = buildProjection({ minX: 0, maxX: 1000, minY: 0, maxY: 10 }, 160, 120, 6);
    const availW = 160 - 12;
    expect(proj.scale).toBeCloseTo(availW / 1000, 6);
  });

  it("flips Y so +Y world is up on screen", () => {
    const proj = buildProjection({ minX: -10, maxX: 10, minY: -10, maxY: 10 }, 100, 100, 0);
    const up = worldToMinimap(proj, 0, 10);
    const down = worldToMinimap(proj, 0, -10);
    expect(up.py).toBeLessThan(down.py); // higher world Y → smaller pixel Y
  });
});

/** Astrolabe V3: the minimap must draw the graph the viewer is LOOKING AT.
 *
 *  V2's MinimapPanel projected `model.positions` wholesale — every node in the
 *  graph, expanded or not — so the dots never matched the stars on screen, and
 *  the map's bounds (hence its scale) were those of a graph nobody was looking
 *  at. Collapsing a directory changed the scene and left the map identical. */
describe("visibleXY — only the currently-visible clusters", () => {
  /** repo → dir "lib" → file "lib/a.ts" → symbol, plus a second top-level
   *  file, so collapsing/expanding "lib" changes the visible set. */
  function model(): ClientModel {
    const g: RawGraph = {
      nodes: [
        { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
        { id: "rs1:r:dir:lib", labels: ["Directory"], props: { path: "lib" } },
        {
          id: "rs1:r:file:lib/a.ts",
          labels: ["File"],
          props: { name: "a.ts", path: "lib/a.ts" },
        },
        { id: "rs1:r:file:b.ts", labels: ["File"], props: { name: "b.ts", path: "b.ts" } },
        {
          id: "rs1:r:sym:lib/a.ts#run@0",
          labels: ["Function"],
          props: { name: "run", file_path: "lib/a.ts", content_hash: "h" },
        },
      ],
      edges: [],
    };
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

  it("emits exactly one XY pair per visible cluster — not one per graph node", () => {
    const m = model();
    const expanded = new Set([m.rootKey]);
    const visible = visibleClusters(m, expanded);
    const xy = visibleXY(m.positions, m.indexByKey, visible);

    expect(xy.length).toBe(visible.size * 2);
    // The whole-graph buffer is strictly larger — which is exactly the
    // mismatch V2 shipped.
    expect(m.positions.length / 3).toBeGreaterThan(visible.size);
  });

  it("grows as clusters expand and shrinks as they collapse", () => {
    const m = model();
    const collapsed = visibleXY(
      m.positions,
      m.indexByKey,
      visibleClusters(m, new Set([m.rootKey])),
    );
    const dirKey = [...m.byKey.keys()].find((k) => k.startsWith("dir:"))!;
    const expanded = visibleXY(
      m.positions,
      m.indexByKey,
      visibleClusters(m, new Set([m.rootKey, dirKey])),
    );
    expect(expanded.length).toBeGreaterThan(collapsed.length);
  });

  it("skips keys with no layout slot rather than pinning them to the origin", () => {
    const m = model();
    const xy = visibleXY(m.positions, m.indexByKey, ["not-a-real-cluster-key"]);
    expect(xy.length).toBe(0);
    // …and a bogus key mixed in with real ones doesn't drag the bounds to (0,0).
    const real = [...visibleClusters(m, new Set([m.rootKey]))];
    const mixed = visibleXY(m.positions, m.indexByKey, [...real, "ghost"]);
    const clean = visibleXY(m.positions, m.indexByKey, real);
    expect(mixed).toEqual(clean);
  });

  it("boundsOfXY reads the 2-stride buffer (a zero box at origin when empty)", () => {
    expect(boundsOfXY(new Float32Array([-4, 9, 11, -2, 0, 0]))).toEqual({
      minX: -4,
      maxX: 11,
      minY: -2,
      maxY: 9,
    });
    expect(boundsOfXY(new Float32Array([]))).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 });
  });

  it("projects the VISIBLE bounds, so the map fills with what's on screen", () => {
    const m = model();
    const visible = visibleClusters(m, new Set([m.rootKey]));
    const xy = visibleXY(m.positions, m.indexByKey, visible);
    const proj = buildProjection(boundsOfXY(xy), 168, 120);
    // Every visible point lands inside the canvas under that projection.
    for (let i = 0; i < xy.length / 2; i++) {
      const { px, py } = worldToMinimap(proj, xy[i * 2]!, xy[i * 2 + 1]!);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(168);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(120);
    }
    // And the visible bounds differ from the whole-graph bounds (the fix).
    expect(boundsOfXY(xy)).not.toEqual(projectBounds(m.positions));
  });
});

describe("viewportHalfExtents — the frustum rectangle", () => {
  it("half-height is tan(fov/2)·distance, half-width scales by aspect", () => {
    const { halfW, halfH } = viewportHalfExtents(100, 90, 2);
    expect(halfH).toBeCloseTo(100, 6); // tan(45°) = 1
    expect(halfW).toBeCloseTo(200, 6);
  });

  it("grows with distance (zooming out shows more world)", () => {
    const near = viewportHalfExtents(50, 55, 1.5);
    const far = viewportHalfExtents(500, 55, 1.5);
    expect(far.halfW).toBeGreaterThan(near.halfW);
    expect(far.halfH).toBeGreaterThan(near.halfH);
  });

  it("degrades to a zero rect on non-finite / non-positive input (draws nothing)", () => {
    for (const args of [
      [0, 55, 1.5],
      [-10, 55, 1.5],
      [100, 0, 1.5],
      [100, 55, 0],
      [Number.NaN, 55, 1.5],
      [100, Number.POSITIVE_INFINITY, 1.5],
    ] as const) {
      expect(viewportHalfExtents(args[0], args[1], args[2])).toEqual({ halfW: 0, halfH: 0 });
    }
  });
});
