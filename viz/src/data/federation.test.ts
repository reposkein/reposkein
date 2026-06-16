import { describe, it, expect } from "vitest";
import { buildClusterTree } from "./cluster";
import { buildModel } from "./model";
import type { RawGraph } from "./types";

/** Synthetic two-repo federation: repo "alpha" and repo "beta", merged into
 *  a single combined graph just as the worker does in M2. */
function twoRepoGraph(): RawGraph {
  return {
    nodes: [
      // --- alpha repo ---
      {
        id: "rs1:alpha:repo:.",
        labels: ["Repository"],
        props: { name: "alpha", is_nested: false, root_path: "." },
      },
      {
        id: "rs1:alpha:dir:.",
        labels: ["Directory"],
        props: { name: ".", path: "." },
      },
      {
        id: "rs1:alpha:file:src/main.ts",
        labels: ["File"],
        props: { name: "main.ts", path: "src/main.ts", language: "typescript" },
      },
      {
        id: "rs1:alpha:func:src/main.ts#run@0",
        labels: ["Function"],
        props: {
          name: "run",
          qualified_name: "run",
          file_path: "src/main.ts",
          start_line: 1,
          end_line: 10,
        },
      },
      // --- beta repo ---
      {
        id: "rs1:beta:repo:.",
        labels: ["Repository"],
        props: { name: "beta", is_nested: false, root_path: "." },
      },
      {
        id: "rs1:beta:dir:.",
        labels: ["Directory"],
        props: { name: ".", path: "." },
      },
      {
        id: "rs1:beta:file:lib/helper.ts",
        labels: ["File"],
        props: { name: "helper.ts", path: "lib/helper.ts", language: "typescript" },
      },
      {
        id: "rs1:beta:func:lib/helper.ts#help@0",
        labels: ["Function"],
        props: {
          name: "help",
          qualified_name: "help",
          file_path: "lib/helper.ts",
          start_line: 1,
          end_line: 5,
        },
      },
    ],
    edges: [
      // Structural edges: alpha
      {
        from: "rs1:alpha:file:src/main.ts",
        type: "DEFINES",
        to: "rs1:alpha:func:src/main.ts#run@0",
        props: {},
      },
      // Structural edges: beta
      {
        from: "rs1:beta:file:lib/helper.ts",
        type: "DEFINES",
        to: "rs1:beta:func:lib/helper.ts#help@0",
        props: {},
      },
      // Cross-repo relationship edge: alpha calls beta
      {
        from: "rs1:alpha:func:src/main.ts#run@0",
        type: "CALLS",
        to: "rs1:beta:func:lib/helper.ts#help@0",
        props: { confidence: 0.9, resolution: "exact" },
      },
    ],
  };
}

describe("federation: two-repo merged graph", () => {
  it("builds a cluster tree containing nodes from both repos", () => {
    const graph = twoRepoGraph();
    const tree = buildClusterTree(graph);

    // The first Repository node wins as the galaxy root.
    expect(tree.repoId).toBe("alpha");
    expect(tree.rootKey).toBe("galaxy:alpha");

    // Alpha's function should be present.
    const alphaFn = tree.byKey.get("rs1:alpha:func:src/main.ts#run@0");
    expect(alphaFn).toBeTruthy();
    expect(alphaFn?.kind).toBe("symbol");

    // Beta's function should also be present (merged in).
    const betaFn = tree.byKey.get("rs1:beta:func:lib/helper.ts#help@0");
    expect(betaFn).toBeTruthy();
    expect(betaFn?.kind).toBe("symbol");
  });

  it("marks the cross-repo CALLS edge as crossRepo: true", () => {
    const graph = twoRepoGraph();
    const model = buildModel(graph);

    const crossEdge = model.drawEdges.find(
      (e) =>
        e.from === "rs1:alpha:func:src/main.ts#run@0" &&
        e.to === "rs1:beta:func:lib/helper.ts#help@0"
    );
    expect(crossEdge).toBeTruthy();
    expect(crossEdge?.crossRepo).toBe(true);
    expect(crossEdge?.type).toBe("CALLS");
  });

  it("does not mark same-repo edges as crossRepo", () => {
    const graph = twoRepoGraph();
    // Add an intra-repo IMPORTS edge within alpha.
    graph.edges.push({
      from: "rs1:alpha:func:src/main.ts#run@0",
      type: "IMPORTS",
      to: "rs1:alpha:func:src/main.ts#run@0",
      props: { confidence: 1.0, resolution: "exact" },
    });
    const model = buildModel(graph);
    const sameRepoEdge = model.drawEdges.find(
      (e) =>
        e.from === "rs1:alpha:func:src/main.ts#run@0" &&
        e.to === "rs1:alpha:func:src/main.ts#run@0" &&
        e.type === "IMPORTS"
    );
    expect(sameRepoEdge?.crossRepo).toBe(false);
  });

  it("records from both repos appear in the model", () => {
    const graph = twoRepoGraph();
    const model = buildModel(graph);

    expect(model.records.has("rs1:alpha:func:src/main.ts#run@0")).toBe(true);
    expect(model.records.has("rs1:beta:func:lib/helper.ts#help@0")).toBe(true);
    expect(model.records.get("rs1:alpha:func:src/main.ts#run@0")?.name).toBe("run");
    expect(model.records.get("rs1:beta:func:lib/helper.ts#help@0")?.name).toBe("help");
  });
});
