import { describe, it, expect } from "vitest";
import { buildModel } from "./model";
import { fromWorker, type ClientModel } from "./clientModel";
import {
  normalizeLanguage,
  languageFromPath,
  dominantLanguage,
  dominantLanguageByCluster,
  presentLanguages,
} from "./language";
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

describe("normalizeLanguage", () => {
  it("canonicalizes common spellings", () => {
    expect(normalizeLanguage("TypeScript")).toBe("typescript");
    expect(normalizeLanguage("C#")).toBe("csharp");
    expect(normalizeLanguage("Golang")).toBe("go");
    expect(normalizeLanguage("  Python ")).toBe("python");
    expect(normalizeLanguage("")).toBe("");
  });
});

describe("languageFromPath (extension inference)", () => {
  it("maps known extensions", () => {
    expect(languageFromPath("src/a.rs")).toBe("rust");
    expect(languageFromPath("src/a.py")).toBe("python");
    expect(languageFromPath("src/a.tsx")).toBe("typescript");
    expect(languageFromPath("src/a.mjs")).toBe("javascript");
    expect(languageFromPath("pkg/main.go")).toBe("go");
    expect(languageFromPath("Foo.java")).toBe("java");
    expect(languageFromPath("Foo.cs")).toBe("csharp");
  });
  it("returns '' for unknown / extensionless paths", () => {
    expect(languageFromPath("README")).toBe("");
    expect(languageFromPath("a.")).toBe("");
    expect(languageFromPath("a.unknownext")).toBe("");
  });
});

/** Two python files + one typescript file under src/ → python dominates src;
 *  a util/ dir with one ts file → typescript dominates util. */
function mixedGraph(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
      { id: "rs1:r:dir:src", labels: ["Directory"], props: { name: "src", path: "src" } },
      { id: "rs1:r:dir:util", labels: ["Directory"], props: { name: "util", path: "util" } },
      // Files: language via prop for some, inferred via extension for others.
      { id: "rs1:r:file:src/a.py", labels: ["File"], props: { name: "a.py", path: "src/a.py", language: "Python" } },
      { id: "rs1:r:file:src/b.py", labels: ["File"], props: { name: "b.py", path: "src/b.py" } }, // inferred
      { id: "rs1:r:file:src/c.ts", labels: ["File"], props: { name: "c.ts", path: "src/c.ts", language: "TypeScript" } },
      { id: "rs1:r:file:util/d.ts", labels: ["File"], props: { name: "d.ts", path: "util/d.ts" } }, // inferred
    ],
    edges: [],
  };
}

describe("dominantLanguage / presentLanguages", () => {
  it("picks the most common descendant-file language per cluster", () => {
    const m = clientModel(mixedGraph());
    // src has 2 python + 1 typescript → python dominates.
    expect(dominantLanguage(m, "dir:r:src")).toBe("python");
    // util has only typescript.
    expect(dominantLanguage(m, "dir:r:util")).toBe("typescript");
    // root galaxy: 3 python? no — 2 python, 2 typescript → tie, break by name
    // (asc) → 'python' < 'typescript'.
    expect(dominantLanguage(m, m.rootKey)).toBe("python");
  });

  it("answers for a single file cluster directly", () => {
    const m = clientModel(mixedGraph());
    expect(dominantLanguage(m, "file:r:src/c.ts")).toBe("typescript");
    expect(dominantLanguage(m, "file:r:src/b.py")).toBe("python"); // inferred
  });

  it("breaks ties deterministically by language name (asc)", () => {
    // One java + one go file under the same dir → tie → 'go' < 'java'.
    const g: RawGraph = {
      nodes: [
        { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
        { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
        { id: "rs1:r:file:x.go", labels: ["File"], props: { name: "x.go", path: "x.go" } },
        { id: "rs1:r:file:y.java", labels: ["File"], props: { name: "y.java", path: "y.java" } },
      ],
      edges: [],
    };
    const m = clientModel(g);
    expect(dominantLanguage(m, m.rootKey)).toBe("go");
  });

  it("lists only the languages present in the graph (sorted)", () => {
    const m = clientModel(mixedGraph());
    expect(presentLanguages(m)).toEqual(["python", "typescript"]);
  });

  it("dominantLanguageByCluster matches per-cluster dominantLanguage", () => {
    const m = clientModel(mixedGraph());
    const byCluster = dominantLanguageByCluster(m);
    expect(byCluster.get("dir:r:src")).toBe("python");
    expect(byCluster.get("dir:r:util")).toBe("typescript");
    expect(byCluster.get(m.rootKey)).toBe("python");
  });

  it("is stable across repeated derivations", () => {
    const a = dominantLanguageByCluster(clientModel(mixedGraph()));
    const b = dominantLanguageByCluster(clientModel(mixedGraph()));
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it("returns '' when no descendant file has a known language", () => {
    const g: RawGraph = {
      nodes: [
        { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
        { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
        { id: "rs1:r:file:README", labels: ["File"], props: { name: "README", path: "README" } },
      ],
      edges: [],
    };
    const m = clientModel(g);
    expect(dominantLanguage(m, m.rootKey)).toBe("");
    expect(presentLanguages(m)).toEqual([]);
  });
});
