/** VIEW HISTORY (Astrolabe V4 §4): the stack, the reducer's restore, and the
 *  round trip between them.
 *
 *  The property that matters is not "back works" but "back then forward is an
 *  EXACT round trip" — including the camera pose, by object identity. A history
 *  that lands you somewhere plausible-but-different is worse than no history at
 *  all, because it silently rewrites what you thought you were looking at. */
import { afterEach, describe, expect, it } from "vitest";
import { createInitialState, reducer, type State } from "./store";
import type { CameraPose } from "./cameraPose";
import { samePose } from "./cameraPose";
import {
  HISTORY_CAP,
  canStepBack,
  canStepForward,
  historyDepth,
  pushView,
  resetViewHistory,
  stepBack,
  stepForward,
  type ViewSnapshot,
} from "./viewHistory";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

afterEach(() => resetViewHistory());

function pose(n: number): CameraPose {
  return { position: [n, n, n], target: [0, 0, n] };
}

function view(selected: string | null, expanded: string[], p: CameraPose | null): ViewSnapshot {
  return { selected, expanded: new Set(expanded), pose: p };
}

describe("the stack: browser semantics, two stacks and no cursor", () => {
  it("starts empty, and neither step is available", () => {
    expect(canStepBack()).toBe(false);
    expect(canStepForward()).toBe(false);
    expect(stepBack(view("a", [], null))).toBeNull();
    expect(stepForward(view("a", [], null))).toBeNull();
  });

  it("back then forward is an exact round trip", () => {
    const first = view("a", ["dir:x"], pose(1));
    pushView(first);
    const current = view("b", ["dir:x", "dir:y"], pose(2));

    const back = stepBack(current);
    expect(back).toBe(first); // the very object, not a copy
    expect(canStepForward()).toBe(true);

    const forward = stepForward(back!);
    expect(forward).toBe(current);
    expect(canStepForward()).toBe(false);
    expect(canStepBack()).toBe(true); // `first` is back on the back stack
  });

  it("carries the camera pose BY IDENTITY through a round trip", () => {
    const p = pose(7);
    const first = view("a", [], p);
    pushView(first);
    const restored = stepBack(view("b", [], pose(8)));
    // Identity, not just equality: a restore that reconstructed the pose would
    // be free to reconstruct it slightly differently.
    expect(restored!.pose).toBe(p);
    expect(samePose(restored!.pose, p)).toBe(true);
  });

  it("a new push abandons the forward branch", () => {
    pushView(view("a", [], pose(1)));
    stepBack(view("b", [], pose(2)));
    expect(canStepForward()).toBe(true);

    pushView(view("c", [], pose(3)));
    expect(canStepForward()).toBe(false);
    expect(historyDepth()).toEqual({ back: 1, forward: 0 });
  });

  it("walks several steps back and forward again in order", () => {
    const views = [0, 1, 2, 3].map((i) => view(`n${i}`, [`dir:${i}`], pose(i)));
    for (const v of views) pushView(v);
    let current = view("now", [], pose(99));

    // Back through all four, newest first.
    for (let i = views.length - 1; i >= 0; i--) {
      const got = stepBack(current);
      expect(got).toBe(views[i]);
      current = got!;
    }
    expect(canStepBack()).toBe(false);

    // …and forward through all four, oldest first.
    for (let i = 1; i < views.length; i++) {
      const got = stepForward(current);
      expect(got).toBe(views[i]);
      current = got!;
    }
    const last = stepForward(current);
    expect(last!.selected).toBe("now");
    expect(canStepForward()).toBe(false);
  });

  it(`is bounded at ${HISTORY_CAP}, dropping the OLDEST entries`, () => {
    for (let i = 0; i < HISTORY_CAP + 10; i++) pushView(view(`n${i}`, [], pose(i)));
    expect(historyDepth().back).toBe(HISTORY_CAP);

    // The most recent push is still the first step back…
    const newest = stepBack(view("now", [], null));
    expect(newest!.selected).toBe(`n${HISTORY_CAP + 9}`);
    // …and the oldest survivor is the 10th push, not the 1st.
    let last = newest!;
    while (canStepBack()) last = stepBack(last)!;
    expect(last.selected).toBe("n10");
  });

  it("resetViewHistory drops both stacks", () => {
    pushView(view("a", [], null));
    stepBack(view("b", [], null));
    resetViewHistory();
    expect(historyDepth()).toEqual({ back: 0, forward: 0 });
  });

  /** FIX ROUND 1, `I2`. A run of identical entries is never useful — `[` would
   *  step through views that all look the same — and under the cap it evicts the
   *  trail the reader actually wants. */
  it("drops a push identical to the top of the stack", () => {
    const p = pose(1);
    const expanded = new Set(["dir:x"]);
    const snap = (): ViewSnapshot => ({ selected: "a", expanded, pose: p });

    pushView(snap());
    pushView(snap());
    pushView(snap());
    expect(historyDepth().back).toBe(1);
  });

  it("…comparing CONTENTS, not references — a fresh equal Set is the same view", () => {
    const p = pose(1);
    // `expandToReveal` allocates a new Set unconditionally, so a repeated reveal
    // of an already-revealed node yields equal-but-distinct Sets. Those describe
    // the same view and must not both be recorded.
    pushView({ selected: "a", expanded: new Set(["x"]), pose: p });
    pushView({ selected: "a", expanded: new Set(["x"]), pose: p });
    expect(historyDepth().back).toBe(1);

    // An equal-VALUED pose object likewise.
    pushView({ selected: "a", expanded: new Set(["x"]), pose: { ...p } });
    expect(historyDepth().back).toBe(1);
  });

  it("…but any real difference still pushes", () => {
    const expanded = new Set(["x"]);
    const p = pose(1);
    pushView({ selected: "a", expanded, pose: p });
    pushView({ selected: "b", expanded, pose: p }); //           selection differs
    pushView({ selected: "b", expanded, pose: pose(2) }); //     pose differs
    pushView({ selected: "b", expanded: new Set(["x", "y"]), pose: pose(2) }); // expansion differs
    expect(historyDepth().back).toBe(4);
  });

  it("the dedupe does not swallow a genuine return to an earlier view", () => {
    const a: ViewSnapshot = { selected: "a", expanded: new Set(), pose: pose(1) };
    const b: ViewSnapshot = { selected: "b", expanded: new Set(), pose: pose(2) };
    pushView(a);
    pushView(b);
    pushView(a); // back to A the long way round — not a duplicate of the top
    expect(historyDepth().back).toBe(3);
  });
});

/** The reducer half: what a restore does to state. */
function clientModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:file:a.ts", labels: ["File"], props: { name: "a.ts", path: "a.ts" } },
      {
        id: "rs1:r:sym:a.ts#run",
        labels: ["Function"],
        props: { name: "run", file_path: "a.ts", content_hash: "h" },
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

describe("restoreView — all three at once, and no refit", () => {
  const model = clientModel();
  const ready = reducer(createInitialState(), { t: "ready", model });

  it("sets selection, expansion and pose in ONE transition", () => {
    const p = pose(4);
    const snapshot = view("rs1:r:sym:a.ts#run", [model.rootKey, "file:r:a.ts"], p);
    const next = reducer(ready, { t: "restoreView", snapshot });

    expect(next.selected).toBe("rs1:r:sym:a.ts#run");
    expect(next.expanded).toBe(snapshot.expanded); // the snapshot's own Set
    expect(next.poseTarget).toBe(p);
    expect(next.poseNonce).toBe(ready.poseNonce + 1);
  });

  it("does NOT bump fitNonce, and clears focusTarget", () => {
    const flown = reducer(ready, {
      t: "revealAndSelect",
      id: "rs1:r:sym:a.ts#run",
      fly: true,
    });
    expect(flown.focusTarget).not.toBeNull();

    const next = reducer(flown, {
      t: "restoreView",
      snapshot: view(null, [model.rootKey], pose(1)),
    });
    // A refit would overwrite the restored pose with a merely plausible frame.
    expect(next.fitNonce).toBe(flown.fitNonce);
    expect(next.focusTarget).toBeNull();
  });

  it("bumps poseNonce even when restoring the SAME pose twice", () => {
    const p = pose(5);
    const once = reducer(ready, { t: "restoreView", snapshot: view("x", [], p) });
    const twice = reducer(once, { t: "restoreView", snapshot: view("x", [], p) });
    expect(twice.poseNonce).toBe(once.poseNonce + 1);
  });

  it("drops overlays — they were computed against a state the snapshot doesn't carry", () => {
    const withOverlay: State = {
      ...ready,
      impact: { sourceId: "x", impacted: new Set(), coveringTests: new Set() },
      focus: { nodes: new Set(["x"]), depth: 1 },
    } as State;
    const next = reducer(withOverlay, {
      t: "restoreView",
      snapshot: view("x", [], null),
    });
    expect(next.impact).toBeNull();
    expect(next.focus).toBeNull();
  });

  it("tolerates a null pose (a restore recorded before the first frame)", () => {
    const next = reducer(ready, { t: "restoreView", snapshot: view("x", [], null) });
    expect(next.poseTarget).toBeNull();
    expect(next.poseNonce).toBe(ready.poseNonce + 1);
  });

  it("clears the hop anchor — it belongs to a step, not to a view", () => {
    const withHop: State = {
      ...ready,
      lastHop: { from: "a", to: "b", dir: "next" },
    } as State;
    const next = reducer(withHop, { t: "restoreView", snapshot: view("x", [], null) });
    // Leaving it would let the next arrow press "return" to an anchor from a
    // different part of the session.
    expect(next.lastHop).toBeNull();
  });

  it("is a no-op before the model loads", () => {
    const cold = createInitialState();
    expect(reducer(cold, { t: "restoreView", snapshot: view("x", [], null) })).toBe(cold);
  });
});
