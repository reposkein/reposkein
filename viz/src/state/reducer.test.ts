import { describe, it, expect } from "vitest";
import { createInitialState, reducer, type State } from "./store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";

/** Reproduce the worker → main-thread handoff without a worker (same shape as
 *  data/revealHelpers.test.ts). */
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

const calls = (fromId: string, toId: string) => ({
  from: fromId,
  type: "CALLS",
  to: toId,
  props: { resolution: "exact", confidence: 1 },
});

function graph(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
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
      F("mcp/a.ts", "a1"),
      F("mcp/deep/b.ts", "b1"),
    ],
    edges: [calls("rs1:r:sym:mcp/a.ts#a1", "rs1:r:sym:mcp/deep/b.ts#b1")],
  };
}

/** A ready store state over `model`, root expanded (what "ready" produces). */
function readyState(model: ClientModel): State {
  return reducer(createInitialState(), { t: "ready", model });
}

const A1 = "rs1:r:sym:mcp/a.ts#a1";
const B1 = "rs1:r:sym:mcp/deep/b.ts#b1";

describe("revealAndSelect", () => {
  it("expands the whole ancestor chain, selects, and bumps fitNonce EXACTLY once", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    const next = reducer(ready, { t: "revealAndSelect", id: B1, fly: true });

    // The chain to a symbol three levels deep opened in one transition...
    expect(next.expanded.has("dir:r:mcp")).toBe(true);
    expect(next.expanded.has("dir:r:mcp/deep")).toBe(true);
    expect(next.expanded.has("file:r:mcp/deep/b.ts")).toBe(true);
    expect(next.selected).toBe(B1);
    expect(next.focusTarget).toBe(B1);
    // ...as ONE state transition. The old path dispatched toggleExpand per
    // ancestor plus select plus setFocusTarget; React's auto-batching already
    // collapsed those into one render and one camera effect, so this is not a
    // "fewer refits" win. What it buys is ATOMICITY: one reducer transition
    // means no intermediate state (half-expanded chain, selected-but-hidden
    // node) exists to be read, rendered, or reasoned about — and fitNonce
    // stays a truthful "one bump per user intent" counter.
    expect(next.fitNonce).toBe(ready.fitNonce + 1);
  });

  it("`fly:false` clears focusTarget and does NOT bump fitNonce (no camera consequence at all)", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    const next = reducer(ready, { t: "revealAndSelect", id: B1 });
    expect(next.selected).toBe(B1);
    expect(next.focusTarget).toBeNull();
    // CRITICAL: unlike a fly, a `fly:false` reveal must not touch fitNonce —
    // Controls' fit effect re-runs on EVERY fitNonce change and would
    // otherwise reframe the camera via its "frame the current selection"
    // fallback, which is exactly the camera movement `fly:false` promises not
    // to cause.
    expect(next.fitNonce).toBe(ready.fitNonce);
  });

  it("a stale focusTarget from an earlier fly never survives a later `fly:false` reveal of a DIFFERENT node", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    // Fly to A1 first: sets focusTarget=A1, bumps fitNonce once.
    const flew = reducer(ready, { t: "revealAndSelect", id: A1, fly: true });
    expect(flew.focusTarget).toBe(A1);
    expect(flew.fitNonce).toBe(ready.fitNonce + 1);

    // Now reveal-without-flying a DIFFERENT node (B1). Before the fix this
    // inherited the OLD focusTarget (A1) while still bumping fitNonce, so
    // Controls' effect would fly to the unrelated earlier target A1 instead
    // of staying put for B1's reveal.
    const revealed = reducer(flew, { t: "revealAndSelect", id: B1 });
    expect(revealed.selected).toBe(B1);
    expect(revealed.focusTarget).toBeNull();
    expect(revealed.fitNonce).toBe(flew.fitNonce); // unchanged — no flight left to hijack.
  });

  it("clears impact/focus when the selection actually changes, keeps them when it doesn't", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    const selected = reducer(ready, { t: "revealAndSelect", id: A1, fly: true });
    const withOverlay: State = {
      ...selected,
      impact: { sourceId: A1, impacted: new Set([B1]), coveringTests: new Set() },
      focus: { nodes: new Set([A1]), depth: 1 },
    } as State;

    // Same node again → overlays survive (matches `select`'s contract).
    const again = reducer(withOverlay, { t: "revealAndSelect", id: A1, fly: true });
    expect(again.impact).toBe(withOverlay.impact);
    expect(again.focus).toBe(withOverlay.focus);

    // Different node → overlays are stale, so they go.
    const other = reducer(withOverlay, { t: "revealAndSelect", id: B1, fly: true });
    expect(other.impact).toBeNull();
    expect(other.focus).toBeNull();
  });

  it("collapseDeeper shuts clusters strictly below the target (breadcrumb walk)", () => {
    const model = clientModel(graph());
    const deep = reducer(readyState(model), { t: "revealAndSelect", id: B1, fly: true });
    expect(deep.expanded.has("file:r:mcp/deep/b.ts")).toBe(true);

    // Click the "mcp" crumb: everything under mcp closes, mcp itself stays open.
    const up = reducer(deep, {
      t: "revealAndSelect",
      id: "dir:r:mcp",
      fly: true,
      collapseDeeper: true,
    });
    expect(up.expanded.has("dir:r:mcp")).toBe(true);
    expect(up.expanded.has("dir:r:mcp/deep")).toBe(false);
    expect(up.expanded.has("file:r:mcp/deep/b.ts")).toBe(false);
    expect(up.expanded.has(model.rootKey)).toBe(true);
    expect(up.selected).toBe("dir:r:mcp");
    expect(up.fitNonce).toBe(deep.fitNonce + 1);
  });

  it("is a no-op before the model loads", () => {
    const cold = createInitialState();
    expect(reducer(cold, { t: "revealAndSelect", id: B1, fly: true })).toBe(cold);
  });
});

describe("revealWithoutRefit", () => {
  it("unions keys into `expanded` and never bumps fitNonce", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    const next = reducer(ready, {
      t: "revealWithoutRefit",
      keys: ["dir:r:mcp", "dir:r:mcp/deep"],
    });
    expect(next.expanded.has("dir:r:mcp")).toBe(true);
    expect(next.expanded.has("dir:r:mcp/deep")).toBe(true);
    expect(next.fitNonce).toBe(ready.fitNonce);
    // Selection and camera untouched — the tour frames its own stop afterwards.
    expect(next.selected).toBe(ready.selected);
    expect(next.focusTarget).toBe(ready.focusTarget);
  });

  it("is set-union, not toggle: an already-open key stays open", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    const once = reducer(ready, { t: "revealWithoutRefit", keys: ["dir:r:mcp"] });
    const twice = reducer(once, { t: "revealWithoutRefit", keys: ["dir:r:mcp"] });
    expect(twice.expanded.has("dir:r:mcp")).toBe(true);
    // Nothing changed → same state object (no wasted render).
    expect(twice).toBe(once);
  });

  it("returns the same state for an empty key list", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    expect(reducer(ready, { t: "revealWithoutRefit", keys: [] })).toBe(ready);
  });
});

describe("setIdleDrift", () => {  it("defaults off and toggles without touching the camera", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    expect(ready.idleDrift).toBe(false);
    const on = reducer(ready, { t: "setIdleDrift", on: true });
    expect(on.idleDrift).toBe(true);
    expect(on.fitNonce).toBe(ready.fitNonce);
    // Idempotent: setting the same value is not a state change.
    expect(reducer(on, { t: "setIdleDrift", on: true })).toBe(on);
  });
});

/** SCOPED COLLAPSE (Astrolabe V4 §2). V3 had ONE collapse: shut the
 *  globally-deepest expanded cluster, wherever it was. That could close a
 *  branch on the far side of the graph from the one you were reading, and it
 *  was bound to Esc, so a stray Esc silently rearranged the scene. `x` and
 *  `⇧x` replace it with two collapses that are both anchored to something the
 *  reader can point at: the selection, and the file level. */
describe("collapseBranch — `x`", () => {
  it("a selected symbol closes ITS file, and the selection climbs to that file", () => {
    const model = clientModel(graph());
    const deep = reducer(readyState(model), { t: "revealAndSelect", id: B1, fly: true });
    const fileKey = "file:r:mcp/deep/b.ts";
    expect(deep.expanded.has(fileKey)).toBe(true);

    const next = reducer(deep, { t: "collapseBranch" });
    expect(next.expanded.has(fileKey)).toBe(false);
    // The directory chain above it stays open — this is a one-level climb.
    expect(next.expanded.has("dir:r:mcp/deep")).toBe(true);
    expect(next.expanded.has("dir:r:mcp")).toBe(true);
    // …and the selection re-anchors to the cluster that just closed, so the
    // breadcrumb never names an invisible star and `x` can be pressed again.
    expect(next.selected).toBe(model.byKey.get(fileKey)!.nodeId);
    expect(next.fitNonce).toBe(deep.fitNonce + 1);
    // A collapse is never a flight.
    expect(next.focusTarget).toBeNull();
  });

  it("is repeatable: symbol → file → folder → folder, terminating at the root", () => {
    const model = clientModel(graph());
    let s = reducer(readyState(model), { t: "revealAndSelect", id: B1, fly: true });

    s = reducer(s, { t: "collapseBranch" }); // closes the file
    expect(s.expanded.has("file:r:mcp/deep/b.ts")).toBe(false);

    s = reducer(s, { t: "collapseBranch" }); // selection is the file → closes mcp/deep
    expect(s.expanded.has("dir:r:mcp/deep")).toBe(false);
    expect(s.expanded.has("dir:r:mcp")).toBe(true);

    s = reducer(s, { t: "collapseBranch" }); // selection is mcp/deep → closes mcp
    expect(s.expanded.has("dir:r:mcp")).toBe(false);
    expect(s.expanded.has(model.rootKey)).toBe(true);

    // Keep climbing (this fixture has a "." directory between the galaxy and
    // `mcp`) until the terminal contract holds: only the root galaxy is left
    // open, the root never closes, so the reducer returns the SAME state — no
    // wasted render, no refit.
    for (let i = 0; i < 8; i++) {
      const next = reducer(s, { t: "collapseBranch" });
      if (next === s) break;
      s = next;
    }
    expect(s.expanded.has(model.rootKey)).toBe(true);
    expect(reducer(s, { t: "collapseBranch" })).toBe(s);
  });

  it("leaves a sibling branch alone — the whole point of scoping", () => {
    const model = clientModel(graph());
    // Open both files: a.ts under mcp, b.ts under mcp/deep.
    let s = reducer(readyState(model), { t: "revealAndSelect", id: A1, fly: true });
    s = reducer(s, { t: "revealAndSelect", id: B1, fly: true });
    expect(s.expanded.has("file:r:mcp/a.ts")).toBe(true);
    expect(s.expanded.has("file:r:mcp/deep/b.ts")).toBe(true);

    // B1 is selected; `x` closes b.ts only. V3's global-deepest collapse had
    // no way to express that.
    const next = reducer(s, { t: "collapseBranch" });
    expect(next.expanded.has("file:r:mcp/deep/b.ts")).toBe(false);
    expect(next.expanded.has("file:r:mcp/a.ts")).toBe(true);
  });

  it("is a no-op with no selection (there is no branch to scope to)", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    expect(ready.selected).toBeNull();
    expect(reducer(ready, { t: "collapseBranch" })).toBe(ready);
  });

  it("is a no-op before the model loads", () => {
    const cold = createInitialState();
    expect(reducer(cold, { t: "collapseBranch" })).toBe(cold);
  });

  it("drops overlays anchored to a selection it moved, and keeps them otherwise", () => {
    const model = clientModel(graph());
    const deep = reducer(readyState(model), { t: "revealAndSelect", id: B1, fly: true });
    const withOverlay: State = {
      ...deep,
      impact: { sourceId: B1, impacted: new Set([A1]), coveringTests: new Set() },
      focus: { nodes: new Set([B1]), depth: 1 },
    } as State;
    const next = reducer(withOverlay, { t: "collapseBranch" });
    expect(next.selected).not.toBe(B1);
    expect(next.impact).toBeNull();
    expect(next.focus).toBeNull();
  });
});

describe("collapseToFileLevel — `⇧x`", () => {
  it("closes every file expansion and keeps the directory chain open", () => {
    const model = clientModel(graph());
    let s = reducer(readyState(model), { t: "revealAndSelect", id: A1, fly: true });
    s = reducer(s, { t: "revealAndSelect", id: B1, fly: true });

    const flat = reducer(s, { t: "collapseToFileLevel" });
    expect(flat.expanded.has("file:r:mcp/a.ts")).toBe(false);
    expect(flat.expanded.has("file:r:mcp/deep/b.ts")).toBe(false);
    expect(flat.expanded.has("dir:r:mcp")).toBe(true);
    expect(flat.expanded.has("dir:r:mcp/deep")).toBe(true);
    expect(flat.expanded.has(model.rootKey)).toBe(true);
    expect(flat.fitNonce).toBe(s.fitNonce + 1);
  });

  it("re-anchors a symbol selection to its file rather than hiding it", () => {
    const model = clientModel(graph());
    const s = reducer(readyState(model), { t: "revealAndSelect", id: B1, fly: true });
    const flat = reducer(s, { t: "collapseToFileLevel" });
    expect(flat.selected).toBe(model.byKey.get("file:r:mcp/deep/b.ts")!.nodeId);
  });

  it("keeps lens, filters and overlays — a zoom-out, NOT a clean slate", () => {
    const model = clientModel(graph());
    let s = reducer(readyState(model), { t: "revealAndSelect", id: B1, fly: true });
    s = reducer(s, { t: "setLens", lens: "calls" });
    s = reducer(s, { t: "toggleCoupling" });
    const flat = reducer(s, { t: "collapseToFileLevel" });
    expect(flat.lens).toBe("calls");
    expect(flat.coupling).toBe(true);
  });

  it("is the same state when nothing above file level is open", () => {
    const model = clientModel(graph());
    const ready = readyState(model);
    expect(reducer(ready, { t: "collapseToFileLevel" })).toBe(ready);
  });

  it("is a no-op before the model loads", () => {
    const cold = createInitialState();
    expect(reducer(cold, { t: "collapseToFileLevel" })).toBe(cold);
  });
});
