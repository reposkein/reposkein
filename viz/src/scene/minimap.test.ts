import { describe, it, expect } from "vitest";
import {
  buildProjection,
  minimapToWorld,
  projectBounds,
  worldToMinimap,
} from "./minimap";

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
