// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

// Controls.tsx pulls in three.js / camera-controls / R3F — none of which need
// to run for this module; only getCameraTarget's return value matters.
const getCameraTarget = vi.fn<() => { x: number; y: number; z: number } | null>();
vi.mock("./Controls", () => ({ getCameraTarget }));

const {
  nearestVisibleCluster,
  startCameraNearestTracking,
  useCameraNearestClusterKey,
  __resetCameraNearestForTests,
  CAMERA_NEAREST_THROTTLE_MS,
} = await import("./cameraNearest");

function twoClusterModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:file:a.ts", labels: ["File"], props: { name: "a.ts", path: "a.ts" } },
      { id: "rs1:r:file:b.ts", labels: ["File"], props: { name: "b.ts", path: "b.ts" } },
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

const FILE_A_KEY = "file:r:a.ts";
// buildClusterTree seeds an implicit root directory cluster ("dir:<repo>:.")
// between the galaxy and any top-level file — it must be expanded too, or
// visibleClusters collapses straight to that dir and never reaches the files.
const ROOT_DIR_KEY = "dir:r:.";

describe("nearestVisibleCluster (pure)", () => {
  it("picks the visible cluster whose position is closest to the target", () => {
    const model = twoClusterModel();
    const expanded = new Set([model.rootKey, ROOT_DIR_KEY]);
    const aIdx = model.indexByKey.get(FILE_A_KEY)!;
    const ax = model.positions[aIdx * 3]!;
    const ay = model.positions[aIdx * 3 + 1]!;
    const az = model.positions[aIdx * 3 + 2]!;
    const key = nearestVisibleCluster(model, expanded, { x: ax, y: ay, z: az });
    expect(key).toBe(FILE_A_KEY);
  });

  it("collapses to the root when nothing is expanded (root is the only visible representative)", () => {
    const model = twoClusterModel();
    const key = nearestVisibleCluster(model, new Set(), { x: 0, y: 0, z: 0 });
    expect(key).toBe(model.rootKey);
  });
});

describe("startCameraNearestTracking — throttled, no per-frame re-render", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getCameraTarget.mockReset();
    __resetCameraNearestForTests();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function mountSubscriber(model: ClientModel) {
    const renderCount = { current: 0 };
    const seenKeys: (string | null)[] = [];
    function Subscriber() {
      const key = useCameraNearestClusterKey();
      renderCount.current += 1;
      seenKeys.push(key);
      useEffect(
        () => startCameraNearestTracking(() => model, () => new Set([model.rootKey, ROOT_DIR_KEY])),
        [],
      );
      return null;
    }
    render(<Subscriber />);
    return { renderCount, seenKeys };
  }

  it("does not sample or re-render before the throttle interval elapses", () => {
    const model = twoClusterModel();
    getCameraTarget.mockReturnValue({ x: 1, y: 0, z: 0 });
    const { renderCount } = mountSubscriber(model);
    const baseline = renderCount.current;

    act(() => {
      vi.advanceTimersByTime(CAMERA_NEAREST_THROTTLE_MS - 10);
    });
    expect(renderCount.current).toBe(baseline); // no update yet
  });

  it("publishes the nearest cluster once the throttle interval elapses", () => {
    const model = twoClusterModel();
    const aIdx = model.indexByKey.get(FILE_A_KEY)!;
    const target = {
      x: model.positions[aIdx * 3]!,
      y: model.positions[aIdx * 3 + 1]!,
      z: model.positions[aIdx * 3 + 2]!,
    };
    getCameraTarget.mockReturnValue(target);
    const { renderCount, seenKeys } = mountSubscriber(model);
    const baseline = renderCount.current;

    act(() => {
      vi.advanceTimersByTime(CAMERA_NEAREST_THROTTLE_MS);
    });
    expect(renderCount.current).toBe(baseline + 1);
    expect(seenKeys.at(-1)).toBe(FILE_A_KEY);
  });

  it("collapses many rapid target changes within one interval into a single publish", () => {
    const model = twoClusterModel();
    getCameraTarget.mockReturnValue({ x: 0, y: 0, z: 0 });
    const { renderCount } = mountSubscriber(model);
    const baseline = renderCount.current;

    // Simulate the camera moving every animation frame (far more often than
    // the 250ms throttle) — cameraTarget itself updates at frame rate in
    // Controls.tsx, but this poll must not react to it that fast.
    for (let i = 0; i < 20; i++) {
      getCameraTarget.mockReturnValue({ x: i, y: 0, z: 0 });
      act(() => {
        vi.advanceTimersByTime(10); // 20 * 10ms = 200ms, still under the throttle
      });
    }
    expect(renderCount.current).toBe(baseline); // still nothing published

    act(() => {
      vi.advanceTimersByTime(CAMERA_NEAREST_THROTTLE_MS); // now it ticks
    });
    expect(renderCount.current).toBe(baseline + 1); // exactly one publish, not 20
  });

  it("stops polling once every subscriber unmounts", () => {
    const model = twoClusterModel();
    getCameraTarget.mockReturnValue({ x: 1, y: 0, z: 0 });
    const view = render(
      (() => {
        function Subscriber() {
          useCameraNearestClusterKey();
          useEffect(
            () => startCameraNearestTracking(() => model, () => new Set([model.rootKey, ROOT_DIR_KEY])),
            [],
          );
          return null;
        }
        return <Subscriber />;
      })(),
    );
    act(() => {
      vi.advanceTimersByTime(CAMERA_NEAREST_THROTTLE_MS);
    });
    view.unmount();
    // After unmount, further timer advances must not throw or touch a
    // torn-down subscriber — the interval was cleared.
    expect(() => act(() => vi.advanceTimersByTime(CAMERA_NEAREST_THROTTLE_MS * 4))).not.toThrow();
  });
});
