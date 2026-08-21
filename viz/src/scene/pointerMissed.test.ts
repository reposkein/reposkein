import { describe, expect, it, vi } from "vitest";
import { reducer, createInitialState, type Actions, type State } from "../state/store";
import { buildModel } from "../data/model";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type { WorkerResult } from "../data/worker/graph.worker";
import type { RawGraph } from "../data/types";
import { handlePointerMissed } from "./pointerMissed";

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

const SYM = "rs1:r:sym:mcp/a.ts#a1";

function graph(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:mcp", labels: ["Directory"], props: { name: "mcp", path: "mcp" } },
      {
        id: "rs1:r:file:mcp/a.ts",
        labels: ["File"],
        props: { name: "a.ts", path: "mcp/a.ts", language: "typescript" },
      },
      {
        id: SYM,
        labels: ["Function"],
        props: { name: "a1", file_path: "mcp/a.ts", content_hash: "h" },
      },
    ],
    edges: [],
  };
}

describe("handlePointerMissed — deselect ONLY (V4 §3)", () => {
  it("a left click on empty space deselects and consumes the gesture", () => {
    const select = vi.fn();
    expect(handlePointerMissed({ button: 0 }, { select } as Pick<Actions, "select">)).toBe(true);
    expect(select).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("middle and right clicks are orbit/pan gestures and are left alone", () => {
    for (const button of [1, 2]) {
      const select = vi.fn();
      expect(handlePointerMissed({ button }, { select } as Pick<Actions, "select">)).toBe(false);
      expect(select).not.toHaveBeenCalled();
    }
  });
});

describe("deselection is not a collapse and not a camera move", () => {
  it("expansion survives a misclick — the V3 regression this replaces", () => {
    const model = clientModel(graph());
    const ready = reducer(createInitialState(), { t: "ready", model });
    const deep = reducer(ready, { t: "revealAndSelect", id: SYM, fly: true });
    expect(deep.expanded.has("file:r:mcp/a.ts")).toBe(true);

    // Route the gesture through the real handler, then the real reducer.
    let next: State = deep;
    handlePointerMissed({ button: 0 }, {
      select: (id) => {
        next = reducer(deep, { t: "select", id });
      },
    } as Pick<Actions, "select">);

    expect(next.selected).toBeNull();
    // Nothing collapsed…
    expect(next.expanded).toEqual(deep.expanded);
    // …and the camera did not move: no fitNonce bump means Controls' fit
    // effect never re-runs, so it can't fall through to "frame everything".
    expect(next.fitNonce).toBe(deep.fitNonce);
    // A one-shot fly request never survives a deselect.
    expect(next.focusTarget).toBeNull();
  });

  it("selecting a node still frames it (deselect is the only silent one)", () => {
    const model = clientModel(graph());
    const ready = reducer(createInitialState(), { t: "ready", model });
    const picked = reducer(ready, { t: "select", id: SYM });
    expect(picked.selected).toBe(SYM);
    expect(picked.fitNonce).toBe(ready.fitNonce + 1);
  });
});
