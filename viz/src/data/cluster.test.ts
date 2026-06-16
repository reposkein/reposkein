import { describe, it, expect } from "vitest";
import { buildClusterTree, flattenTree } from "./cluster";
import type { RawGraph } from "./types";

/** A small synthetic graph mirroring real RepoSkein JSONL shape. */
function sampleGraph(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r", is_nested: false, root_path: "." } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
      { id: "rs1:r:dir:src", labels: ["Directory"], props: { name: "src", path: "src" } },
      {
        id: "rs1:r:file:src/a.py",
        labels: ["File"],
        props: { name: "a.py", path: "src/a.py", extension: "py", language: "python" },
      },
      {
        id: "rs1:r:class:src/a.py#A",
        labels: ["Class"],
        props: { name: "A", qualified_name: "A", file_path: "src/a.py", start_line: 1, end_line: 9 },
      },
      {
        id: "rs1:r:func:src/a.py#f@1",
        labels: ["Function"],
        props: { name: "f", qualified_name: "f", file_path: "src/a.py", start_line: 2, end_line: 4 },
      },
      // A symbol with NO File node + NO DEFINES edge (file_path fallback path).
      {
        id: "rs1:r:func:lib/util.ts#g@0",
        labels: ["Function"],
        props: { name: "g", qualified_name: "g", file_path: "lib/util.ts" },
      },
    ],
    edges: [
      { from: "rs1:r:dir:.", type: "CONTAINS", to: "rs1:r:dir:src", props: {} },
      { from: "rs1:r:file:src/a.py", type: "DEFINES", to: "rs1:r:class:src/a.py#A", props: {} },
      { from: "rs1:r:file:src/a.py", type: "DEFINES", to: "rs1:r:func:src/a.py#f@1", props: {} },
      // a relationship edge (should not affect the tree)
      {
        from: "rs1:r:func:src/a.py#f@1",
        type: "CALLS",
        to: "rs1:r:func:lib/util.ts#g@0",
        props: { confidence: 1.0, resolution: "exact" },
      },
    ],
  };
}

describe("buildClusterTree", () => {
  it("derives repo→dir→file→symbol from props + structural edges", () => {
    const tree = buildClusterTree(sampleGraph());
    expect(tree.repoId).toBe("r");
    expect(tree.rootKey).toBe("galaxy:r");

    const galaxy = tree.byKey.get("galaxy:r")!;
    expect(galaxy.kind).toBe("galaxy");

    const rootDir = tree.byKey.get("dir:r:.")!;
    expect(rootDir.parent).toBe("galaxy:r");

    const srcDir = tree.byKey.get("dir:r:src")!;
    expect(srcDir.parent).toBe("dir:r:.");

    const file = tree.byKey.get("file:r:src/a.py")!;
    expect(file.kind).toBe("file");
    expect(file.parent).toBe("dir:r:src");

    // Symbols attach to their file via DEFINES.
    const cls = tree.byKey.get("rs1:r:class:src/a.py#A")!;
    expect(cls.kind).toBe("symbol");
    expect(cls.symbolKind).toBe("Class");
    expect(cls.parent).toBe("file:r:src/a.py");

    const fn = tree.byKey.get("rs1:r:func:src/a.py#f@1")!;
    expect(fn.parent).toBe("file:r:src/a.py");
  });

  it("uses the file_path string fallback when no File node / DEFINES edge exists", () => {
    const tree = buildClusterTree(sampleGraph());
    // lib/util.ts had no File node + no DEFINES; the dir chain + file are synthesized.
    const libDir = tree.byKey.get("dir:r:lib")!;
    expect(libDir).toBeTruthy();
    expect(libDir.parent).toBe("dir:r:.");
    const synthFile = tree.byKey.get("file:r:lib/util.ts")!;
    expect(synthFile).toBeTruthy();
    expect(synthFile.parent).toBe("dir:r:lib");
    const g = tree.byKey.get("rs1:r:func:lib/util.ts#g@0")!;
    expect(g.parent).toBe("file:r:lib/util.ts");
  });

  it("children are sorted deterministically", () => {
    const a = flattenTree(buildClusterTree(sampleGraph()));
    const b = flattenTree(buildClusterTree(sampleGraph()));
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key));
  });
});
