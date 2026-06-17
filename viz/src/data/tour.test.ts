import { describe, it, expect } from "vitest";
import { buildModel } from "./model";
import { fromWorker, type ClientModel } from "./clientModel";
import { buildTour } from "./tour";
import type { WorkerResult } from "./worker/graph.worker";
import type { RawGraph } from "./types";

/** Reproduce the worker → main-thread handoff without a worker. */
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

/** A small but structurally rich repo: two top-level dirs, files, symbols, a
 *  class hierarchy, and a clear call hub. */
function graph(): RawGraph {
  const F = (path: string, name: string, label = "Function") => ({
    id: `rs1:r:sym:${path}#${name}`,
    labels: [label],
    props: { name, qualified_name: `${path}::${name}`, file_path: path, content_hash: `h-${name}` },
  });
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
      { id: "rs1:r:dir:core", labels: ["Directory"], props: { name: "core", path: "core" } },
      { id: "rs1:r:dir:util", labels: ["Directory"], props: { name: "util", path: "util" } },
      { id: "rs1:r:file:core/a.ts", labels: ["File"], props: { name: "a.ts", path: "core/a.ts", language: "typescript" } },
      { id: "rs1:r:file:core/b.ts", labels: ["File"], props: { name: "b.ts", path: "core/b.ts", language: "typescript" } },
      { id: "rs1:r:file:util/c.ts", labels: ["File"], props: { name: "c.ts", path: "util/c.ts", language: "typescript" } },
      F("core/a.ts", "main"),
      F("core/a.ts", "helper"),
      F("core/b.ts", "hub"),
      F("util/c.ts", "leaf"),
      F("util/c.ts", "extra"),
      F("core/a.ts", "Base", "Class"),
      F("core/b.ts", "Derived", "Class"),
      F("core/b.ts", "Shape", "Interface"),
    ],
    edges: [
      // hub is called from many places (high in-degree → busiest hub).
      { from: "rs1:r:sym:core/a.ts#main", type: "CALLS", to: "rs1:r:sym:core/b.ts#hub", props: { resolution: "exact", confidence: 1 } },
      { from: "rs1:r:sym:core/a.ts#helper", type: "CALLS", to: "rs1:r:sym:core/b.ts#hub", props: { resolution: "exact", confidence: 1 } },
      { from: "rs1:r:sym:util/c.ts#leaf", type: "CALLS", to: "rs1:r:sym:core/b.ts#hub", props: { resolution: "exact", confidence: 1 } },
      { from: "rs1:r:sym:util/c.ts#extra", type: "CALLS", to: "rs1:r:sym:core/b.ts#hub", props: { resolution: "exact", confidence: 1 } },
      // main has high out-degree → entry point.
      { from: "rs1:r:sym:core/a.ts#main", type: "CALLS", to: "rs1:r:sym:core/a.ts#helper", props: { resolution: "exact", confidence: 1 } },
      { from: "rs1:r:sym:core/a.ts#main", type: "CALLS", to: "rs1:r:sym:util/c.ts#leaf", props: { resolution: "exact", confidence: 1 } },
      // Type hierarchy: Derived inherits Base, Derived implements Shape.
      { from: "rs1:r:sym:core/b.ts#Derived", type: "INHERITS", to: "rs1:r:sym:core/a.ts#Base", props: { resolution: "exact", confidence: 1 } },
      { from: "rs1:r:sym:core/b.ts#Derived", type: "IMPLEMENTS", to: "rs1:r:sym:core/b.ts#Shape", props: { resolution: "exact", confidence: 1 } },
    ],
  };
}

describe("buildTour (deterministic stop derivation)", () => {
  it("starts with an overview framing the whole repo", () => {
    const tour = buildTour(clientModel(graph()));
    expect(tour.length).toBeGreaterThan(0);
    const first = tour[0]!;
    expect(first.id).toBe("overview");
    expect(first.kind).toBe("overview");
    expect(first.targetKey).toBe("galaxy:r");
    expect(first.expandKeys).toEqual([]);
    expect(first.expandDepth).toBe(0);
    expect(first.lens).toBe("all");
    expect(first.focusNodeId).toBeNull();
    expect(first.collapsePrevious).toBe(true);
    expect(first.caption.title).toBe("r");
    // counts come from model.counts (nodes/edges) and module count.
    expect(first.caption.body).toContain("nodes");
    expect(first.caption.body).toContain("edges");
    expect(first.caption.body).toContain("modules");
  });

  it("is stable across repeated runs (same stops, same order)", () => {
    const a = buildTour(clientModel(graph()));
    const b = buildTour(clientModel(graph()));
    expect(a).toEqual(b);
    // Deterministic ordering of ids too (explicit, not just deep-equal).
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });

  it("every stop resets prior expansion and is capped to one expand level", () => {
    const tour = buildTour(clientModel(graph()));
    for (const s of tour) {
      expect(s.collapsePrevious).toBe(true);
      expect(s.expandDepth).toBeLessThanOrEqual(1);
    }
  });

  it("shows a single, lens-appropriate view per stop kind", () => {
    const tour = buildTour(clientModel(graph()));
    for (const s of tour) {
      if (s.kind === "overview") expect(s.lens).toBe("all");
      // Module stops open exactly their module key to depth 1 under imports.
      if (s.kind === "module") {
        expect(s.lens).toBe("imports");
        expect(s.expandDepth).toBe(1);
        expect(s.expandKeys).toEqual([s.targetKey]);
        expect(s.focusNodeId).toBeNull();
      }
      // Node stops never expand a module; they arm focus on their target.
      if (s.kind === "node") {
        expect(s.expandKeys).toEqual([]);
        expect(s.expandDepth).toBe(0);
        expect(s.focusNodeId).toBe(s.targetKey);
        expect(["calls", "types"]).toContain(s.lens);
      }
    }
  });

  it("includes the busiest hub with an in-degree caption", () => {
    const tour = buildTour(clientModel(graph()));
    const hub = tour.find((s) => s.id.startsWith("hub:"));
    expect(hub).toBeDefined();
    // hub is called from 4 places (main, helper, leaf, extra).
    expect(hub!.kind).toBe("node");
    expect(hub!.lens).toBe("calls");
    expect(hub!.caption.title).toBe("hub");
    expect(hub!.caption.body).toBe("called from 4 places");
    expect(hub!.targetKey).toBe("rs1:r:sym:core/b.ts#hub");
    expect(hub!.focusNodeId).toBe("rs1:r:sym:core/b.ts#hub");
  });

  it("includes a type-hierarchy stop for the most-connected Class/Interface", () => {
    const tour = buildTour(clientModel(graph()));
    const type = tour.find((s) => s.id.startsWith("type:"));
    expect(type).toBeDefined();
    // Derived has 2 incident type edges (INHERITS Base + IMPLEMENTS Shape).
    expect(type!.kind).toBe("node");
    expect(type!.lens).toBe("types");
    expect(type!.caption.title).toBe("Derived");
    expect(type!.caption.body).toContain("Class");
    expect(type!.caption.body).toContain("type link");
  });

  it("includes module stops ordered by descendant count, tie-broken by key", () => {
    const tour = buildTour(clientModel(graph()));
    const modules = tour.filter((s) => s.id.startsWith("module:"));
    expect(modules.length).toBeGreaterThanOrEqual(1);
    // 'core' has more descendants than 'util' → core appears first.
    expect(modules[0]!.caption.title).toBe("core");
    expect(modules[0]!.kind).toBe("module");
    expect(modules[0]!.targetKey).toBe("dir:r:core");
    expect(modules[0]!.expandKeys).toEqual(["dir:r:core"]);
    expect(modules[0]!.expandDepth).toBe(1);
    expect(modules[0]!.lens).toBe("imports");
    expect(modules[0]!.caption.body).toContain("file");
    expect(modules[0]!.caption.body).toContain("symbol");
  });

  it("caps the number of stops to a small cinematic count", () => {
    const tour = buildTour(clientModel(graph()));
    expect(tour.length).toBeLessThanOrEqual(9);
  });

  it("the entry-point stop is a different node than the busiest hub", () => {
    const tour = buildTour(clientModel(graph()));
    const hub = tour.find((s) => s.id.startsWith("hub:"));
    const entry = tour.find((s) => s.id.startsWith("entry:"));
    if (entry && hub) {
      expect(entry.targetKey).not.toBe(hub.targetKey);
    }
  });

  it("degrades gracefully on an edgeless graph (overview + modules only)", () => {
    const g: RawGraph = {
      nodes: [
        { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
        { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
        { id: "rs1:r:file:x.ts", labels: ["File"], props: { name: "x.ts", path: "x.ts" } },
        { id: "rs1:r:sym:x.ts#only", labels: ["Function"], props: { name: "only", file_path: "x.ts" } },
      ],
      edges: [],
    };
    const tour = buildTour(clientModel(g));
    expect(tour[0]!.id).toBe("overview");
    // No relationship edges → no hub/type/entry stops.
    expect(tour.some((s) => s.id.startsWith("hub:"))).toBe(false);
    expect(tour.some((s) => s.id.startsWith("type:"))).toBe(false);
    expect(tour.some((s) => s.id.startsWith("entry:"))).toBe(false);
  });
});
