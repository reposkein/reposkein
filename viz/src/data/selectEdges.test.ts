import { describe, it, expect } from "vitest";
import { buildModel } from "./model";
import {
  fromWorker,
  selectVisibleEdges,
  fileOf,
  MAX_BUNDLES,
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

/** Two files, each with several symbols and many intra-/inter-file edges. */
function mcpish(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
      { id: "rs1:r:dir:mcp", labels: ["Directory"], props: { name: "mcp", path: "mcp" } },
      { id: "rs1:r:file:mcp/a.ts", labels: ["File"], props: { name: "a.ts", path: "mcp/a.ts", language: "typescript" } },
      { id: "rs1:r:file:mcp/b.ts", labels: ["File"], props: { name: "b.ts", path: "mcp/b.ts", language: "typescript" } },
      F("mcp/a.ts", "a1"),
      F("mcp/a.ts", "a2"),
      F("mcp/a.ts", "a3"),
      F("mcp/b.ts", "b1"),
      F("mcp/b.ts", "b2"),
    ],
    edges: [
      // intra-file a edges (would be file self-loops when clamped).
      calls("rs1:r:sym:mcp/a.ts#a1", "rs1:r:sym:mcp/a.ts#a2"),
      calls("rs1:r:sym:mcp/a.ts#a2", "rs1:r:sym:mcp/a.ts#a3"),
      // cross-file a -> b edges (collapse to one file↔file bundle).
      calls("rs1:r:sym:mcp/a.ts#a1", "rs1:r:sym:mcp/b.ts#b1"),
      calls("rs1:r:sym:mcp/a.ts#a2", "rs1:r:sym:mcp/b.ts#b2"),
      calls("rs1:r:sym:mcp/a.ts#a3", "rs1:r:sym:mcp/b.ts#b1"),
    ],
  };
}

const noFilter = { edgeTypes: new Set<string>(), minConfidence: 0, audit: "off" };

describe("selectVisibleEdges — LOD clamp (hairball fix)", () => {
  it("collapses symbol↔symbol edges to file cores with nothing active", () => {
    const m = clientModel(mcpish());
    // Expand the module to depth-1 (files visible, symbols collapsed into files)
    // — the real "expand mcp" scenario. Files are NOT explicitly expanded, so
    // they don't join activeFiles and symbols clamp up to their file cores.
    const expanded = new Set<string>(["galaxy:r", "dir:r:.", "dir:r:mcp"]);
    const { bundles } = selectVisibleEdges(m, { expanded, filters: noFilter, activeNodes: [] });
    const fileA = "file:r:mcp/a.ts";
    const fileB = "file:r:mcp/b.ts";
    // The only surviving bundle is fileA↔fileB (intra-file became self-loops).
    expect(bundles.length).toBe(1);
    const b = bundles[0]!;
    expect(new Set([b.srcKey, b.dstKey])).toEqual(new Set([fileA, fileB]));
    expect(b.count).toBe(3); // the three cross-file edges
  });

  it("re-reveals a file's symbol granularity when it is active", () => {
    const m = clientModel(mcpish());
    // Symbols visible in the tree but module expanded to files; file a becomes
    // active via the selected symbol, file b stays a collapsed file core.
    const expanded = new Set<string>(["galaxy:r", "dir:r:.", "dir:r:mcp", "file:r:mcp/a.ts", "file:r:mcp/b.ts"]);
    const { bundles } = selectVisibleEdges(m, {
      expanded,
      filters: noFilter,
      activeNodes: ["rs1:r:sym:mcp/a.ts#a1"],
    });
    // a's symbols are now endpoints.
    const hasSymbolSrc = bundles.some((b) => b.srcKey.startsWith("rs1:r:sym:mcp/a.ts"));
    expect(hasSymbolSrc).toBe(true);
    // intra-file a edges (a1->a2, a2->a3) now survive as symbol↔symbol bundles.
    expect(bundles.length).toBeGreaterThan(1);
  });

  it("clamp case: a module child that is a dir (not a file) stays a core", () => {
    // Edges between the two FILE cores when only dirs/files are visible: the
    // representativeFor lands on a non-symbol, so lodRepresentativeFor returns
    // it unchanged (no file clamp needed).
    const m = clientModel(mcpish());
    // Expand only galaxy + root dir + mcp dir (files visible, symbols collapsed).
    const expanded = new Set<string>(["galaxy:r", "dir:r:.", "dir:r:mcp"]);
    const { bundles } = selectVisibleEdges(m, { expanded, filters: noFilter, activeNodes: [] });
    // Files are the visible reps; cross-file edges still bundle fileA↔fileB.
    expect(bundles.length).toBe(1);
    expect(bundles[0]!.srcKey.startsWith("file:")).toBe(true);
    expect(bundles[0]!.dstKey.startsWith("file:")).toBe(true);
  });

  it("lengthAtten is monotonic non-increasing in chord length", () => {
    const m = clientModel(mcpish());
    const expanded = new Set<string>([...m.byKey.keys()]);
    const { bundles } = selectVisibleEdges(m, { expanded, filters: noFilter, activeNodes: ["rs1:r:sym:mcp/a.ts#a1"] });
    for (const b of bundles) {
      expect(b.lengthAtten).toBeGreaterThanOrEqual(0.12);
      expect(b.lengthAtten).toBeLessThanOrEqual(1);
    }
  });

  it("reports the PRE-cap total (drawn ≤ total, both ≤ MAX_BUNDLES cap)", () => {
    const m = clientModel(mcpish());
    const expanded = new Set<string>([...m.byKey.keys()]);
    const { bundles, total } = selectVisibleEdges(m, { expanded, filters: noFilter, activeNodes: [] });
    expect(bundles.length).toBeLessThanOrEqual(total);
    expect(bundles.length).toBeLessThanOrEqual(MAX_BUNDLES);
  });
});

describe("selectVisibleEdges — determinism", () => {
  it("is byte-stable across two calls on identical state", () => {
    const m = clientModel(mcpish());
    const expanded = new Set<string>([...m.byKey.keys()]);
    const opts = { expanded, filters: noFilter, activeNodes: ["rs1:r:sym:mcp/a.ts#a1"] };
    const r1 = selectVisibleEdges(m, opts);
    const r2 = selectVisibleEdges(m, opts);
    const norm = (r: ReturnType<typeof selectVisibleEdges>) =>
      r.bundles.map((b) => ({
        srcKey: b.srcKey,
        dstKey: b.dstKey,
        count: b.count,
        dominantType: b.dominantType,
        bestResolution: b.bestResolution,
        lengthAtten: b.lengthAtten,
      }));
    expect(norm(r1)).toEqual(norm(r2));
    expect(r1.total).toBe(r2.total);
  });
});

describe("fileOf", () => {
  it("returns the deepest file ancestor for a symbol", () => {
    const m = clientModel(mcpish());
    expect(fileOf(m, "rs1:r:sym:mcp/a.ts#a1")).toBe("file:r:mcp/a.ts");
  });
});
