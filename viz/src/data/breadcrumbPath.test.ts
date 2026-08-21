import { describe, expect, it } from "vitest";
import { buildModel } from "./model";
import { fromWorker, type ClientModel } from "./clientModel";
import type { WorkerResult } from "./worker/graph.worker";
import type { RawGraph } from "./types";
import { cameraCrumbs, resolveBreadcrumb, selectionCrumbs } from "./breadcrumbPath";

/** Nested repo → dir "src" → dir "src/util" → file "src/util/a.ts" → symbol
 *  "run", so ancestor chains have real depth to assert on. Mirrors the
 *  tinyModel helper pattern used by tourPaletteStacking.test.tsx.
 *
 *  Cluster keys are NOT the raw node ids for dirs/files (buildClusterTree
 *  mints its own `dir:<repo>:<path>` / `file:<repo>:<path>` keys) — only a
 *  symbol's cluster key equals its node id. cluster.ts also seeds an implicit
 *  root directory cluster ("dir:r:.") between the galaxy and "src", named
 *  after the repoId same as the galaxy — hence "r" appearing twice in the
 *  expected label chains below; that's the existing tree shape, not
 *  something this task introduces. */
function nestedModel(): ClientModel {
  const g: RawGraph = {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:src", labels: ["Directory"], props: { path: "src" } },
      { id: "rs1:r:dir:src/util", labels: ["Directory"], props: { path: "src/util" } },
      {
        id: "rs1:r:file:src/util/a.ts",
        labels: ["File"],
        props: { name: "a.ts", path: "src/util/a.ts" },
      },
      {
        id: "rs1:r:sym:src/util/a.ts#run@0",
        labels: ["Function"],
        props: {
          name: "run",
          qualified_name: "util::run",
          file_path: "src/util/a.ts",
          content_hash: "h",
        },
      },
    ],
    edges: [
      {
        from: "rs1:r:file:src/util/a.ts",
        to: "rs1:r:sym:src/util/a.ts#run@0",
        type: "DEFINES",
        props: {},
      },
    ],
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

const FILE_KEY = "file:r:src/util/a.ts";
const UTIL_DIR_KEY = "dir:r:src/util";
const SYMBOL_ID = "rs1:r:sym:src/util/a.ts#run@0";
const FILE_NODE_ID = "rs1:r:file:src/util/a.ts";

describe("selectionCrumbs", () => {
  it("builds the full ancestor chain for a selected symbol (the symbol IS its own cluster key, so it terminates its own chain)", () => {
    const model = nestedModel();
    const crumbs = selectionCrumbs(model, SYMBOL_ID);
    expect(crumbs.map((c) => c.label)).toEqual(["r", "r", "src", "util", "a.ts", "run"]);
    expect(crumbs.map((c) => c.key)).toEqual([
      "galaxy:r",
      "dir:r:.",
      "dir:r:src",
      UTIL_DIR_KEY,
      FILE_KEY,
      SYMBOL_ID,
    ]);
    // Every chain crumb navigates — there is no synthetic non-cluster leaf here.
    expect(crumbs.every((c) => c.clickable)).toBe(true);
  });

  it("builds the chain for a selected cluster (file) with every crumb clickable", () => {
    const model = nestedModel();
    const crumbs = selectionCrumbs(model, FILE_NODE_ID);
    expect(crumbs.map((c) => c.label)).toEqual(["r", "r", "src", "util", "a.ts"]);
    expect(crumbs.every((c) => c.clickable)).toBe(true);
  });

  it("appends an inert synthetic leaf only for a record with no cluster entry of its own", () => {
    // A node whose id has NO cluster key at all (byKey.has(id) === false) but
    // does have a records entry — the defensive fallback path. Constructed
    // directly rather than via a real graph shape (every real symbol/file/dir
    // gets a cluster key), to exercise that branch deterministically.
    const model = nestedModel();
    const fakeId = "rs1:r:orphan:not-a-cluster";
    model.records.set(fakeId, {
      id: fakeId,
      name: "orphan",
      qualifiedName: "orphan",
      kind: "Orphan",
      filePath: "",
      startLine: 0,
      endLine: 0,
      language: "",
      role: "",
      semanticSummary: null,
      summaryOfHash: null,
      contentHash: null,
      degree: 0,
    });
    const crumbs = selectionCrumbs(model, fakeId);
    expect(crumbs.at(-1)).toEqual({ key: fakeId, label: "orphan", clickable: false });
    expect(crumbs.slice(0, -1).every((c) => c.clickable)).toBe(true);
  });
});

describe("cameraCrumbs", () => {
  it("builds the ancestor chain of the nearest cluster", () => {
    const model = nestedModel();
    const crumbs = cameraCrumbs(model, UTIL_DIR_KEY);
    expect(crumbs.map((c) => c.label)).toEqual(["r", "r", "src", "util"]);
    expect(crumbs.every((c) => c.clickable)).toBe(true);
  });

  it("falls back to the repo root when nearestKey is null", () => {
    const model = nestedModel();
    const crumbs = cameraCrumbs(model, null);
    expect(crumbs).toEqual([{ key: model.rootKey, label: "r", clickable: true }]);
  });
});

describe("resolveBreadcrumb (the status bar's single entry point)", () => {
  it("uses the selection chain when a node is selected, ignoring the camera hint", () => {
    const model = nestedModel();
    const crumbs = resolveBreadcrumb(model, FILE_NODE_ID, UTIL_DIR_KEY);
    expect(crumbs.map((c) => c.label)).toEqual(["r", "r", "src", "util", "a.ts"]);
  });

  it("falls back to the camera-nearest cluster chain when nothing is selected", () => {
    const model = nestedModel();
    const crumbs = resolveBreadcrumb(model, null, UTIL_DIR_KEY);
    expect(crumbs.map((c) => c.label)).toEqual(["r", "r", "src", "util"]);
  });

  it("is never empty: no selection and no camera sample yet still returns the root", () => {
    const model = nestedModel();
    const crumbs = resolveBreadcrumb(model, null, null);
    expect(crumbs.length).toBeGreaterThan(0);
    expect(crumbs[0]!.key).toBe(model.rootKey);
  });
});
