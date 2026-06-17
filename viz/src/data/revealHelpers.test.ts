import { describe, it, expect } from "vitest";
import { buildModel } from "./model";
import {
  fromWorker,
  revealChainFor,
  expandToReveal,
  hoverHighlightReps,
  visibleClusters,
  representativeFor,
  type ClientModel,
} from "./clientModel";
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

/** Two dirs, two files, a small call graph. */
function graph(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
      { id: "rs1:r:dir:mcp", labels: ["Directory"], props: { name: "mcp", path: "mcp" } },
      { id: "rs1:r:file:mcp/a.ts", labels: ["File"], props: { name: "a.ts", path: "mcp/a.ts", language: "typescript" } },
      { id: "rs1:r:file:mcp/b.ts", labels: ["File"], props: { name: "b.ts", path: "mcp/b.ts", language: "typescript" } },
      F("mcp/a.ts", "a1"),
      F("mcp/a.ts", "a2"),
      F("mcp/b.ts", "b1"),
    ],
    edges: [
      calls("rs1:r:sym:mcp/a.ts#a1", "rs1:r:sym:mcp/a.ts#a2"),
      calls("rs1:r:sym:mcp/a.ts#a1", "rs1:r:sym:mcp/b.ts#b1"),
    ],
  };
}

describe("revealChainFor", () => {
  it("returns the expandable ancestor chain (root→...→deepest cluster) of a symbol", () => {
    const m = clientModel(graph());
    const chain = revealChainFor(m, "rs1:r:sym:mcp/a.ts#a1");
    // Every returned key is expandable (has children) and on the symbol's chain.
    for (const k of chain) {
      expect(m.byKey.get(k)!.children.length).toBeGreaterThan(0);
    }
    // The deepest expandable ancestor (the file) must be included.
    expect(chain).toContain("file:r:mcp/a.ts");
    // It is in root→self order: rootKey first.
    expect(chain[0]).toBe(m.rootKey);
  });

  it("returns the chain for a cluster key passed directly (Breadcrumb case)", () => {
    const m = clientModel(graph());
    // A crumb key is a cluster key, not a node id; clusterOfNode misses it and
    // the helper falls back to the key itself.
    const chain = revealChainFor(m, "dir:r:mcp");
    expect(chain).toContain("dir:r:mcp");
    expect(chain[0]).toBe(m.rootKey);
    // Does NOT include descendants below dir:r:mcp (only the chain UP to it).
    expect(chain).not.toContain("file:r:mcp/a.ts");
  });

  it("returns [] for an unknown id", () => {
    const m = clientModel(graph());
    expect(revealChainFor(m, "does-not-exist")).toEqual([]);
  });
});

describe("expandToReveal", () => {
  it("adds every expandable ancestor of each node to a NEW set (input untouched)", () => {
    const m = clientModel(graph());
    const before = new Set<string>([m.rootKey]);
    const after = expandToReveal(m, before, ["rs1:r:sym:mcp/b.ts#b1"]);
    expect(after).not.toBe(before);
    expect(before.size).toBe(1); // input not mutated
    expect(after.has("file:r:mcp/b.ts")).toBe(true);
    expect(after.has("dir:r:mcp")).toBe(true);
    expect(after.has(m.rootKey)).toBe(true);
  });
});

describe("neighborsByNode + hoverHighlightReps", () => {
  it("builds a bidirectional adjacency from drawEdges", () => {
    const m = clientModel(graph());
    const a1 = "rs1:r:sym:mcp/a.ts#a1";
    const a2 = "rs1:r:sym:mcp/a.ts#a2";
    const b1 = "rs1:r:sym:mcp/b.ts#b1";
    expect(m.neighborsByNode.get(a1)).toEqual(new Set([a2, b1]));
    // Reverse direction is present too.
    expect(m.neighborsByNode.get(a2)!.has(a1)).toBe(true);
    expect(m.neighborsByNode.get(b1)!.has(a1)).toBe(true);
  });

  it("rolls the hovered node + its 1-hop neighbors up to visible reps", () => {
    const m = clientModel(graph());
    // Fully expand so symbols are the visible reps.
    const expanded = new Set<string>([...m.byKey.keys()].filter((k) => {
      return (m.byKey.get(k)!.children.length ?? 0) > 0;
    }));
    const visible = visibleClusters(m, expanded);
    const a1 = "rs1:r:sym:mcp/a.ts#a1";
    const reps = hoverHighlightReps(m, a1, visible)!;
    // Self + both neighbors' reps are present.
    expect(reps.has(representativeFor(m, a1, visible)!)).toBe(true);
    expect(reps.has(representativeFor(m, "rs1:r:sym:mcp/a.ts#a2", visible)!)).toBe(true);
    expect(reps.has(representativeFor(m, "rs1:r:sym:mcp/b.ts#b1", visible)!)).toBe(true);
  });

  it("rolls neighbors up to a COLLAPSED file core (works at any LOD)", () => {
    const m = clientModel(graph());
    // Only dirs expanded → files are collapsed cores; a1's neighbor b1 rolls up
    // to the b.ts file core.
    const expanded = new Set<string>(["galaxy:r", "dir:r:.", "dir:r:mcp"]);
    const visible = visibleClusters(m, expanded);
    const reps = hoverHighlightReps(m, "rs1:r:sym:mcp/a.ts#a1", visible)!;
    expect(reps.has("file:r:mcp/a.ts")).toBe(true); // self rep
    expect(reps.has("file:r:mcp/b.ts")).toBe(true); // neighbor b1 rolled up
  });

  it("returns null when nothing is hovered", () => {
    const m = clientModel(graph());
    expect(hoverHighlightReps(m, null, new Set())).toBeNull();
  });

  it("matches the old full-edge-scan result (regression guard)", () => {
    const m = clientModel(graph());
    const expanded = new Set<string>([...m.byKey.keys()].filter((k) => (m.byKey.get(k)!.children.length ?? 0) > 0));
    const visible = visibleClusters(m, expanded);
    const hovered = "rs1:r:sym:mcp/a.ts#a1";
    // Reference implementation: the exact scan the helper replaced.
    const ref = new Set<string>();
    const self = representativeFor(m, hovered, visible);
    if (self) ref.add(self);
    for (const e of m.drawEdges) {
      if (e.from === hovered) {
        const r = representativeFor(m, e.to, visible);
        if (r) ref.add(r);
      } else if (e.to === hovered) {
        const r = representativeFor(m, e.from, visible);
        if (r) ref.add(r);
      }
    }
    expect(hoverHighlightReps(m, hovered, visible)).toEqual(ref);
  });
});
