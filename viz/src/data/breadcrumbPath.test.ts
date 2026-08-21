import { describe, expect, it } from "vitest";
import { buildModel } from "./model";
import { fromWorker, type ClientModel } from "./clientModel";
import type { WorkerResult } from "./worker/graph.worker";
import type { RawGraph } from "./types";
import {
  cameraCrumbs,
  resolveBreadcrumb,
  selectionCrumbs,
  collapseCrumbsForDisplay,
  breadcrumbMaxVisibleForWidth,
  dedupeAdjacentCrumbLabels,
  type Crumb,
} from "./breadcrumbPath";

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
    // The adjacent "r"/"r" pair (galaxy + its same-named implicit root dir —
    // see nestedModel's docstring) is folded into one crumb (fix round 2 /
    // REP-22 polish: "repo + root galaxy both 'reposkein'" read as a bug).
    expect(crumbs.map((c) => c.label)).toEqual(["r", "src", "util", "a.ts"]);
    // The fold keeps the DEEPER of the two same-labelled crumbs' key, so
    // clicking it still navigates to the more specific (root dir) scope.
    expect(crumbs[0]!.key).toBe("dir:r:.");
  });

  it("falls back to the camera-nearest cluster chain when nothing is selected", () => {
    const model = nestedModel();
    const crumbs = resolveBreadcrumb(model, null, UTIL_DIR_KEY);
    expect(crumbs.map((c) => c.label)).toEqual(["r", "src", "util"]);
  });

  it("is never empty: no selection and no camera sample yet still returns the root", () => {
    const model = nestedModel();
    const crumbs = resolveBreadcrumb(model, null, null);
    expect(crumbs.length).toBeGreaterThan(0);
    expect(crumbs[0]!.key).toBe(model.rootKey);
  });
});

describe("dedupeAdjacentCrumbLabels (fix round 2 / REP-22 polish)", () => {
  it("folds a run of adjacent same-label crumbs into one, keeping the deepest key", () => {
    const chain = [crumb("reposkein"), { key: "dir:root", label: "reposkein", clickable: true }, crumb("src")];
    expect(dedupeAdjacentCrumbLabels(chain)).toEqual([
      { key: "dir:root", label: "reposkein", clickable: true },
      crumb("src"),
    ]);
  });

  it("is a no-op when no two adjacent crumbs share a label", () => {
    const chain = [crumb("reposkein"), crumb("src"), crumb("util")];
    expect(dedupeAdjacentCrumbLabels(chain)).toEqual(chain);
  });

  it("does not fold NON-adjacent duplicates (only adjacent runs collapse)", () => {
    const chain = [crumb("a"), crumb("b"), crumb("a")];
    expect(dedupeAdjacentCrumbLabels(chain)).toEqual(chain);
  });

  it("leaves an empty or single-crumb chain untouched", () => {
    expect(dedupeAdjacentCrumbLabels([])).toEqual([]);
    expect(dedupeAdjacentCrumbLabels([crumb("a")])).toEqual([crumb("a")]);
  });
});

function crumb(label: string, clickable = true): Crumb {
  return { key: label, label, clickable };
}

describe("collapseCrumbsForDisplay (fix round 1, #2 — breadcrumb truncates first, middle-ellipsis)", () => {
  it("returns the chain unchanged when it already fits", () => {
    const chain = [crumb("a"), crumb("b"), crumb("c")];
    expect(collapseCrumbsForDisplay(chain, 4)).toBe(chain); // same reference — no allocation when it fits
    expect(collapseCrumbsForDisplay(chain, Infinity)).toBe(chain);
  });

  it("keeps the head and the tail, replacing the middle with one inert '…' crumb", () => {
    const chain = [crumb("root"), crumb("a"), crumb("b"), crumb("c"), crumb("leaf")];
    const collapsed = collapseCrumbsForDisplay(chain, 4);
    expect(collapsed.map((c) => c.label)).toEqual(["root", "…", "c", "leaf"]);
    expect(collapsed[1]!.clickable).toBe(false);
    expect(collapsed[1]!.key).not.toBe("a"); // a real cluster key would collide with the ellipsis marker
  });

  it("clamps maxVisible below 3 up to 3 (head + ellipsis + >=1 tail, never fewer)", () => {
    const chain = [crumb("root"), crumb("a"), crumb("b"), crumb("c"), crumb("leaf")];
    const collapsed = collapseCrumbsForDisplay(chain, 1);
    expect(collapsed.map((c) => c.label)).toEqual(["root", "…", "leaf"]);
  });

  it("a chain exactly at the clamped size is left alone (no pointless collapse)", () => {
    const chain = [crumb("root"), crumb("a"), crumb("leaf")];
    expect(collapseCrumbsForDisplay(chain, 1)).toBe(chain);
  });
});

describe("breadcrumbMaxVisibleForWidth (fix round 1, #2)", () => {
  it("shows the full chain at wide widths", () => {
    expect(breadcrumbMaxVisibleForWidth(1280)).toBe(Infinity);
    expect(breadcrumbMaxVisibleForWidth(1024)).toBe(Infinity);
  });

  it("starts collapsing below 1024 — WIDER than the left section's widest drop threshold (768), so it gives ground first", () => {
    expect(breadcrumbMaxVisibleForWidth(1023)).toBeLessThan(Infinity);
    expect(breadcrumbMaxVisibleForWidth(800)).toBe(4);
  });

  it("collapses further at the narrowest widths", () => {
    expect(breadcrumbMaxVisibleForWidth(639)).toBe(3);
    expect(breadcrumbMaxVisibleForWidth(360)).toBe(3);
  });
});

/** `inspectorOpen=true` (fix round 2 / REP-22 polish, review finding #5 —
 *  previously untested directly, only exercised indirectly through
 *  StatusBar.test.tsx's integration test). Reserves the Inspector's own
 *  360px column + 3 gutters (396px) before doing the same width-tier lookup,
 *  so the SAME width collapses one tier sooner whenever the drawer is open. */
describe("breadcrumbMaxVisibleForWidth — inspectorOpen reserves the drawer's column", () => {
  it("the exact scenario this fixed: 1280px shows everything with no selection, but tiers down to 4 with one", () => {
    expect(breadcrumbMaxVisibleForWidth(1280)).toBe(Infinity);
    expect(breadcrumbMaxVisibleForWidth(1280, true)).toBe(4);
  });

  it("the SAME raw width can land in a different tier purely based on inspectorOpen", () => {
    expect(breadcrumbMaxVisibleForWidth(1024, false)).toBe(Infinity);
    expect(breadcrumbMaxVisibleForWidth(1024, true)).toBe(3); // 1024-396=628, below the 640 tier
  });

  it("still reaches Infinity once the raw width is wide enough to absorb the reservation", () => {
    expect(breadcrumbMaxVisibleForWidth(1419, true)).toBeLessThan(Infinity);
    expect(breadcrumbMaxVisibleForWidth(1420, true)).toBe(Infinity); // 1420-396=1024
  });

  it("the 640-tier boundary shifts by exactly the reservation too", () => {
    expect(breadcrumbMaxVisibleForWidth(1035, true)).toBe(3); // 1035-396=639
    expect(breadcrumbMaxVisibleForWidth(1036, true)).toBe(4); // 1036-396=640
  });

  it("defaults to false (inspectorOpen is optional) — same as never passing it", () => {
    expect(breadcrumbMaxVisibleForWidth(1280)).toBe(breadcrumbMaxVisibleForWidth(1280, false));
  });
});
