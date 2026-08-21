// @vitest-environment jsdom
//
// VIEW HISTORY, THROUGH THE REAL PROVIDER (Astrolabe V4 §4).
//
// `viewHistory.test.ts` covers the stack and the reducer separately. This file
// covers the WIRING between them, which is where the interesting mistakes live:
// which actions record a view, which deliberately don't, and whether `[` really
// lands the reader back in the frame they left — camera included.
//
// The push happens inside the store's action wrappers rather than at each of the
// ~six navigation call sites (palette jump, arrow hop, breadcrumb click, cluster
// click, both collapses). That is a deliberate choice — a new navigation UI gets
// history for free and no call site can push twice or forget — and this is the
// test that says the resulting coverage is the coverage the brief asked for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StoreProvider, useActions, useStoreState, type Actions, type State } from "./store";
import { publishCameraPose, resetCameraPose, type CameraPose } from "./cameraPose";
import { historyDepth, resetViewHistory } from "./viewHistory";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

/** The provider spins up the layout worker on mount. jsdom has none, so this
 *  fake stands in — and hands the test the `onmessage` hook, which is how a
 *  loaded model gets into a REAL provider without a test-only action. */
let liveWorker: { post: (r: WorkerResult) => void } | null = null;
vi.mock("../data/worker/graph.worker.ts?worker", () => ({
  default: class {
    onmessage: ((e: { data: WorkerResult }) => void) | null = null;
    onerror: unknown = null;
    constructor() {
      liveWorker = { post: (r) => this.onmessage?.({ data: r }) };
    }
    postMessage() {}
    terminate() {
      liveWorker = null;
    }
  },
}));

const SYM_A = "rs1:r:sym:mcp/a.ts#a1";
const SYM_B = "rs1:r:sym:mcp/deep/b.ts#b1";
const FILE_A = "file:r:mcp/a.ts";
const DIR_DEEP = "dir:r:mcp/deep";

function workerResult(): WorkerResult {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:mcp", labels: ["Directory"], props: { name: "mcp", path: "mcp" } },
      { id: "rs1:r:dir:mcp/deep", labels: ["Directory"], props: { name: "deep", path: "mcp/deep" } },
      {
        id: "rs1:r:file:mcp/a.ts",
        labels: ["File"],
        props: { name: "a.ts", path: "mcp/a.ts", language: "typescript" },
      },
      {
        id: "rs1:r:file:mcp/deep/b.ts",
        labels: ["File"],
        props: { name: "b.ts", path: "mcp/deep/b.ts", language: "typescript" },
      },
      {
        id: SYM_A,
        labels: ["Function"],
        props: { name: "a1", file_path: "mcp/a.ts", content_hash: "h1" },
      },
      {
        id: SYM_B,
        labels: ["Function"],
        props: { name: "b1", file_path: "mcp/deep/b.ts", content_hash: "h2" },
      },
    ],
    edges: [],
  };
  const m = buildModel(g);
  return {
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
}

interface Harness {
  state: () => State;
  actions: Actions;
  model: ClientModel;
}

/** A real StoreProvider with a loaded model, plus live handles to state and the
 *  (identity-stable) action surface. */
function mount(): Harness {
  let state: State | null = null;
  let actions: Actions | null = null;
  function Probe() {
    state = useStoreState();
    actions = useActions();
    return null;
  }
  render(
    <StoreProvider>
      <Probe />
    </StoreProvider>,
  );
  const result = workerResult();
  act(() => liveWorker!.post(result));
  return { state: () => state!, actions: actions!, model: fromWorker(result) };
}

const POSE_1: CameraPose = { position: [1, 1, 1], target: [0, 0, 0] };
const POSE_2: CameraPose = { position: [2, 2, 2], target: [0, 0, 1] };
const POSE_3: CameraPose = { position: [3, 3, 3], target: [0, 0, 2] };

beforeEach(() => {
  resetViewHistory();
  resetCameraPose();
});

afterEach(() => {
  cleanup();
  resetViewHistory();
  resetCameraPose();
});

describe("which actions record a view", () => {
  it("a reveal (palette jump / hop / breadcrumb) records the view it left", () => {
    const h = mount();
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    expect(historyDepth()).toEqual({ back: 1, forward: 0 });
  });

  it("a cluster expand/collapse records", () => {
    const h = mount();
    act(() => h.actions.toggleExpand("dir:r:mcp"));
    expect(historyDepth().back).toBe(1);
  });

  it("both scoped collapses record", () => {
    const h = mount();
    act(() => h.actions.revealAndSelect(SYM_B, { fly: true })); // 1
    act(() => h.actions.collapseBranch()); //                       2
    act(() => h.actions.collapseToFileLevel()); //                  3
    expect(historyDepth().back).toBe(3);
  });

  it("select does NOT record — inspecting is not moving, and deselect must not spam the stack", () => {
    const h = mount();
    act(() => h.actions.select(SYM_A));
    act(() => h.actions.select(null)); // Esc / misclick
    act(() => h.actions.select(SYM_B));
    expect(historyDepth()).toEqual({ back: 0, forward: 0 });
  });

  it("requestFit and revealWithoutRefit do NOT record (camera-only; tour-driven)", () => {
    const h = mount();
    act(() => h.actions.requestFit());
    act(() => h.actions.revealWithoutRefit(["dir:r:mcp"]));
    expect(historyDepth()).toEqual({ back: 0, forward: 0 });
  });

  it("records nothing before the model loads — there is nothing to return to", () => {
    let actions: Actions | null = null;
    function Probe() {
      actions = useActions();
      return null;
    }
    render(
      <StoreProvider>
        <Probe />
      </StoreProvider>,
    );
    act(() => actions!.revealAndSelect(SYM_A, { fly: true }));
    act(() => actions!.toggleExpand("dir:r:mcp"));
    expect(historyDepth()).toEqual({ back: 0, forward: 0 });
  });
});

describe("the round trip a reader performs", () => {
  it("`[` restores selection, expansion AND the exact camera pose of the view it left", () => {
    const h = mount();

    // Frame 1: nothing selected, only the root open, camera at POSE_1.
    publishCameraPose(POSE_1);
    const expandedBefore = h.state().expanded;
    expect(h.state().selected).toBeNull();

    // Navigate: jump to a symbol three levels down. Camera settles at POSE_2.
    act(() => h.actions.revealAndSelect(SYM_B, { fly: true }));
    publishCameraPose(POSE_2);
    expect(h.state().selected).toBe(SYM_B);
    expect(h.state().expanded).not.toBe(expandedBefore);

    // Back.
    let moved: boolean | null = null;
    act(() => {
      moved = h.actions.historyBack();
    });
    expect(moved).toBe(true);
    expect(h.state().selected).toBeNull();
    expect(h.state().expanded).toBe(expandedBefore); // the very Set, not a copy
    expect(h.state().poseTarget).toBe(POSE_1); //       the very pose object
  });

  it("`]` returns to the view `[` left, pose included", () => {
    const h = mount();
    publishCameraPose(POSE_1);
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    publishCameraPose(POSE_2);
    const afterJump = h.state().expanded;

    act(() => void h.actions.historyBack());
    publishCameraPose(POSE_3); // the restore flight settled somewhere new

    let moved: boolean | null = null;
    act(() => {
      moved = h.actions.historyForward();
    });
    expect(moved).toBe(true);
    expect(h.state().selected).toBe(SYM_A);
    expect(h.state().expanded).toBe(afterJump);
    expect(h.state().poseTarget).toBe(POSE_2);
  });

  it("bumps poseNonce once per step, and never fitNonce", () => {
    const h = mount();
    publishCameraPose(POSE_1);
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    const afterJump = { pose: h.state().poseNonce, fit: h.state().fitNonce };

    act(() => void h.actions.historyBack());
    expect(h.state().poseNonce).toBe(afterJump.pose + 1);
    // A refit would re-derive a frame and overwrite the restored pose.
    expect(h.state().fitNonce).toBe(afterJump.fit);
  });

  it("walks a three-step trail back and forward again", () => {
    const h = mount();
    publishCameraPose(POSE_1);
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    act(() => h.actions.toggleExpand(DIR_DEEP));
    act(() => h.actions.revealAndSelect(SYM_B, { fly: true }));
    expect(historyDepth()).toEqual({ back: 3, forward: 0 });

    act(() => void h.actions.historyBack());
    act(() => void h.actions.historyBack());
    act(() => void h.actions.historyBack());
    expect(historyDepth()).toEqual({ back: 0, forward: 3 });
    expect(h.state().selected).toBeNull(); // the very first view

    act(() => void h.actions.historyForward());
    expect(h.state().selected).toBe(SYM_A);
    act(() => void h.actions.historyForward());
    act(() => void h.actions.historyForward());
    expect(h.state().selected).toBe(SYM_B);
    expect(historyDepth()).toEqual({ back: 3, forward: 0 });
  });

  it("a new navigation after `[` abandons the forward branch", () => {
    const h = mount();
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    act(() => void h.actions.historyBack());
    expect(historyDepth().forward).toBe(1);

    act(() => h.actions.revealAndSelect(SYM_B, { fly: true }));
    expect(historyDepth().forward).toBe(0);
  });

  it("tolerates a cold history entry with no pose (deep link before the first frame)", () => {
    const h = mount(); // no publishCameraPose at all
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    act(() => void h.actions.historyBack());
    expect(h.state().poseTarget).toBeNull();
    expect(h.state().selected).toBeNull();
  });
});

/** DECISION (V4 §8): a clean slate is a FRESH START. Walking `[` back into a
 *  pre-reset view would resurrect exactly the expansion and overlays the reader
 *  just asked to be rid of, and restore a camera pose framing a scene that no
 *  longer exists. */
describe("every cleanSlate path clears the history stack", () => {
  it("Clean slate (resetView)", () => {
    const h = mount();
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    act(() => h.actions.resetView());
    expect(historyDepth()).toEqual({ back: 0, forward: 0 });
  });

  it("Reset expansion", () => {
    const h = mount();
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    act(() => h.actions.resetExpansion());
    expect(historyDepth()).toEqual({ back: 0, forward: 0 });
  });

  it("Tour entry — otherwise `[` would step through a cinematic already exited", () => {
    const h = mount();
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    act(() => h.actions.startTour());
    expect(historyDepth()).toEqual({ back: 0, forward: 0 });
  });

  it("and the forward branch too", () => {
    const h = mount();
    act(() => h.actions.revealAndSelect(SYM_A, { fly: true }));
    act(() => void h.actions.historyBack());
    expect(historyDepth().forward).toBe(1);
    act(() => h.actions.resetView());
    expect(historyDepth()).toEqual({ back: 0, forward: 0 });
  });
});

describe("expansion snapshots are safe to hold by reference", () => {
  it("a restored expansion Set is the one the reducer had, and later edits don't mutate it", () => {
    const h = mount();
    const original = h.state().expanded;
    act(() => h.actions.toggleExpand("dir:r:mcp"));
    // The reducer builds a NEW Set per transition, so the snapshot's reference
    // is still the pre-navigation contents. This is the invariant that lets
    // history hold Sets without cloning them.
    expect(h.state().expanded).not.toBe(original);
    expect(original.has("dir:r:mcp")).toBe(false);

    act(() => void h.actions.historyBack());
    expect(h.state().expanded).toBe(original);
    expect(h.state().expanded.has(FILE_A)).toBe(false);
  });
});
