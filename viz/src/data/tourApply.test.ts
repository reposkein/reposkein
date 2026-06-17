import { describe, it, expect } from "vitest";
import { buildModel } from "./model";
import { fromWorker, type ClientModel } from "./clientModel";
import { buildTour, type TourStop } from "./tour";
import { tourExpandKeys } from "./tourApply";
import type { WorkerResult } from "./worker/graph.worker";
import type { RawGraph } from "./types";

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

const F = (path: string, name: string, label = "Function") => ({
  id: `rs1:r:sym:${path}#${name}`,
  labels: [label],
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
      { id: "rs1:r:dir:core", labels: ["Directory"], props: { name: "core", path: "core" } },
      { id: "rs1:r:dir:util", labels: ["Directory"], props: { name: "util", path: "util" } },
      { id: "rs1:r:file:core/a.ts", labels: ["File"], props: { name: "a.ts", path: "core/a.ts", language: "typescript" } },
      { id: "rs1:r:file:util/b.ts", labels: ["File"], props: { name: "b.ts", path: "util/b.ts", language: "typescript" } },
      F("core/a.ts", "a1"),
      F("core/a.ts", "a2"),
      F("util/b.ts", "b1"),
    ],
    edges: [
      calls("rs1:r:sym:core/a.ts#a1", "rs1:r:sym:util/b.ts#b1"),
      calls("rs1:r:sym:core/a.ts#a2", "rs1:r:sym:util/b.ts#b1"),
    ],
  };
}

describe("tourExpandKeys — post-reset expansion (stale-snapshot bug)", () => {
  it("module stop computes expand keys against {root}, NOT the stale snapshot", () => {
    const m = clientModel(graph());
    const moduleStop: TourStop = {
      id: "module:dir:r:core",
      kind: "module",
      targetKey: "dir:r:core",
      expandKeys: ["dir:r:core"],
      expandDepth: 1,
      lens: "imports",
      focusNodeId: null,
      collapsePrevious: true,
      caption: { title: "core", body: "" },
    };
    // STALE SNAPSHOT: the previous render had dir:r:core already expanded. The
    // old code read this set AFTER resetExpansion and (wrongly) skipped the key,
    // leaving the stop empty. The fix computes against the post-reset {root}.
    const staleExpanded = new Set<string>([m.rootKey, "dir:r:core", "file:r:core/a.ts"]);
    const keys = tourExpandKeys(m, moduleStop, staleExpanded);
    expect(keys).toEqual(["dir:r:core"]); // re-opened despite the stale snapshot
  });

  it("node stop reveals the focus node's expandable ancestor chain post-reset", () => {
    const m = clientModel(graph());
    const nodeStop: TourStop = {
      id: "node:b1",
      kind: "node",
      targetKey: "rs1:r:sym:util/b.ts#b1",
      expandKeys: [],
      expandDepth: 0,
      lens: "calls",
      focusNodeId: "rs1:r:sym:util/b.ts#b1",
      collapsePrevious: true,
      caption: { title: "b1", body: "" },
    };
    // A stale snapshot where util was already open before the reset.
    const stale = new Set<string>([m.rootKey, "dir:r:util", "file:r:util/b.ts"]);
    const keys = tourExpandKeys(m, nodeStop, stale);
    // The chain to b1 (minus the already-implied root) is re-opened.
    expect(keys).toContain("dir:r:util");
    expect(keys).toContain("file:r:util/b.ts");
    // root is implied by the post-reset base; never emitted as a toggle.
    expect(keys).not.toContain(m.rootKey);
    // Every emitted key is expandable.
    for (const k of keys) expect(m.byKey.get(k)!.children.length).toBeGreaterThan(0);
  });

  it("emits no duplicate toggles (a key already in the post-reset base is skipped)", () => {
    const m = clientModel(graph());
    const overviewStop = buildTour(m)[0]!; // overview: no expand
    expect(overviewStop.kind).toBe("overview");
    expect(tourExpandKeys(m, overviewStop, new Set([m.rootKey]))).toEqual([]);
  });

  it("non-collapsing stop builds on the CURRENT expansion", () => {
    const m = clientModel(graph());
    const stop: TourStop = {
      id: "module:dir:r:core",
      kind: "module",
      targetKey: "dir:r:core",
      expandKeys: ["dir:r:core"],
      expandDepth: 1,
      lens: "imports",
      focusNodeId: null,
      collapsePrevious: false, // builds on current state
      caption: { title: "core", body: "" },
    };
    // Already expanded in the current (non-stale, since not resetting) state.
    const current = new Set<string>([m.rootKey, "dir:r:core"]);
    expect(tourExpandKeys(m, stop, current)).toEqual([]); // nothing new to open
    // Not yet expanded → emit it.
    expect(tourExpandKeys(m, stop, new Set([m.rootKey]))).toEqual(["dir:r:core"]);
  });

  it("is deterministic across identical calls", () => {
    const m = clientModel(graph());
    const stops = buildTour(m);
    for (const stop of stops) {
      const r1 = tourExpandKeys(m, stop, new Set([m.rootKey]));
      const r2 = tourExpandKeys(m, stop, new Set([m.rootKey]));
      expect(r1).toEqual(r2);
    }
  });
});
