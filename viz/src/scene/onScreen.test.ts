import { describe, expect, it } from "vitest";
import { isNodeOnScreen, isPointOnScreen } from "./onScreen";
import type { CameraPose } from "../state/cameraPose";
import type { CameraView } from "./Controls";

/** Looking down -Z from (0,0,100) at the origin — the app's default camera. */
const POSE: CameraPose = { position: [0, 0, 100], target: [0, 0, 0] };
/** 55° vertical fov, 16:9 — matches Root's <Canvas camera> and a wide window. */
const VIEW: CameraView = { distance: 100, fov: 55, aspect: 16 / 9 };

describe("isPointOnScreen", () => {
  it("the point the camera is aimed at is on screen", () => {
    expect(isPointOnScreen(POSE, VIEW, 0, 0, 0)).toBe(true);
  });

  it("a point behind the camera is off screen", () => {
    expect(isPointOnScreen(POSE, VIEW, 0, 0, 200)).toBe(false);
  });

  it("a point far to the side is off screen; the same point near the axis is not", () => {
    // At depth 100 the half-height is tan(27.5°)·100 ≈ 52, half-width ≈ 92.
    expect(isPointOnScreen(POSE, VIEW, 10, 0, 0)).toBe(true);
    expect(isPointOnScreen(POSE, VIEW, 500, 0, 0)).toBe(false);
  });

  it("respects the vertical field of view", () => {
    expect(isPointOnScreen(POSE, VIEW, 0, 20, 0)).toBe(true);
    expect(isPointOnScreen(POSE, VIEW, 0, 300, 0)).toBe(false);
  });

  it("insets the edge: a point right on the boundary does NOT count as visible", () => {
    // Half-height at depth 100 for fov 55.
    const halfH = Math.tan((55 * Math.PI) / 360) * 100;
    expect(isPointOnScreen(POSE, VIEW, 0, halfH * 0.5, 0)).toBe(true);
    // A star one pixel inside the frame is practically invisible, and treating
    // it as visible is how a hop leaves the reader hunting for the selection.
    expect(isPointOnScreen(POSE, VIEW, 0, halfH * 0.99, 0)).toBe(false);
  });

  it("the frustum WIDENS with depth (perspective, not a slab)", () => {
    const far: CameraPose = { position: [0, 0, 1000], target: [0, 0, 0] };
    // 200 units off-axis: outside the frustum up close, inside it far away.
    expect(isPointOnScreen(POSE, VIEW, 200, 0, 0)).toBe(false);
    expect(isPointOnScreen(far, { ...VIEW, distance: 1000 }, 200, 0, 0)).toBe(true);
  });

  it("handles a camera looking straight down (+Y up is degenerate there)", () => {
    const top: CameraPose = { position: [0, 100, 0], target: [0, 0, 0] };
    expect(isPointOnScreen(top, VIEW, 0, 0, 0)).toBe(true);
    expect(isPointOnScreen(top, VIEW, 0, 0, 500)).toBe(false);
  });

  /** UNKNOWN COUNTS AS OFF SCREEN, so a caller deciding whether to fly flies. A
   *  wasted animation is cheap; a selection the reader cannot see is not. */
  describe("unknown answers false", () => {
    it("with no pose", () => {
      expect(isPointOnScreen(null, VIEW, 0, 0, 0)).toBe(false);
    });

    it("with no perspective params (orthographic / pre-mount)", () => {
      expect(isPointOnScreen(POSE, null, 0, 0, 0)).toBe(false);
    });

    it("with a degenerate fov or aspect", () => {
      expect(isPointOnScreen(POSE, { ...VIEW, fov: 0 }, 0, 0, 0)).toBe(false);
      expect(isPointOnScreen(POSE, { ...VIEW, aspect: 0 }, 0, 0, 0)).toBe(false);
      expect(isPointOnScreen(POSE, { ...VIEW, fov: NaN }, 0, 0, 0)).toBe(false);
    });

    it("with a non-finite point", () => {
      expect(isPointOnScreen(POSE, VIEW, NaN, 0, 0)).toBe(false);
    });

    it("when the camera sits exactly on its target (no forward direction)", () => {
      const degenerate: CameraPose = { position: [1, 1, 1], target: [1, 1, 1] };
      expect(isPointOnScreen(degenerate, VIEW, 0, 0, 0)).toBe(false);
    });
  });
});

describe("isNodeOnScreen", () => {
  const model = {
    positions: new Float32Array([0, 0, 0, 400, 0, 0]),
    indexByKey: new Map([
      ["k:near", 0],
      ["k:far", 1],
    ]),
    clusterOfNode: new Map([
      ["node-near", "k:near"],
      ["node-far", "k:far"],
    ]),
  };

  it("resolves a node id through its cluster key to a layout slot", () => {
    expect(isNodeOnScreen(model, "node-near", POSE, VIEW)).toBe(true);
    expect(isNodeOnScreen(model, "node-far", POSE, VIEW)).toBe(false);
  });

  it("falls back to treating the id AS the key (symbols are their own cluster)", () => {
    expect(isNodeOnScreen(model, "k:near", POSE, VIEW)).toBe(true);
  });

  it("a node with no layout slot answers false → the hop flies", () => {
    expect(isNodeOnScreen(model, "nowhere", POSE, VIEW)).toBe(false);
  });
});
