import { describe, it, expect } from "vitest";
import { buildCouplingLinks, type CochangeMap } from "./temporal";
import { buildClusterTree } from "./cluster";
import type { ClusterNode } from "./cluster";
import type { ClientModel } from "./clientModel";
import type { RawGraph } from "./types";

/** A two-file graph in repo "r". */
function graph(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r" } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
      { id: "rs1:r:dir:src", labels: ["Directory"], props: { name: "src", path: "src" } },
      { id: "rs1:r:file:src/a.py", labels: ["File"], props: { name: "a.py", path: "src/a.py" } },
      { id: "rs1:r:file:src/b.py", labels: ["File"], props: { name: "b.py", path: "src/b.py" } },
    ],
    edges: [],
  };
}

/** Build a ClientModel-ish object with the fields buildCouplingLinks reads:
 *  repoId, byKey, ancestors, clusterOfNode, indexByKey. */
function model(): ClientModel {
  const tree = buildClusterTree(graph());
  const byKey = tree.byKey;
  const clusterOfNode = new Map<string, string>();
  for (const c of byKey.values()) if (c.nodeId) clusterOfNode.set(c.nodeId, c.key);
  const ancestors = new Map<string, string[]>();
  const chainOf = (key: string): string[] => {
    const cached = ancestors.get(key);
    if (cached) return cached;
    const c: ClusterNode | undefined = byKey.get(key);
    if (!c) return [key];
    const chain = c.parent ? [...chainOf(c.parent), key] : [key];
    ancestors.set(key, chain);
    return chain;
  };
  for (const k of byKey.keys()) chainOf(k);
  const indexByKey = new Map<string, number>();
  [...byKey.keys()].forEach((k, i) => indexByKey.set(k, i));
  return {
    repoId: tree.repoId,
    byKey,
    ancestors,
    clusterOfNode,
    indexByKey,
  } as unknown as ClientModel;
}

describe("temporal coupling links", () => {
  it("builds one undirected link between visible file representatives", () => {
    const m = model();
    const cochange: CochangeMap = {
      "src/a.py": [{ path: "src/b.py", support: 5, confidence: 0.8 }],
      "src/b.py": [{ path: "src/a.py", support: 5, confidence: 0.6 }],
    };
    const visible = new Set(["file:r:src/a.py", "file:r:src/b.py"]);
    const links = buildCouplingLinks(m, cochange, visible);
    expect(links).toHaveLength(1); // both directions collapse to one link
    expect(links[0]!.aKey).toBe("file:r:src/a.py");
    expect(links[0]!.bKey).toBe("file:r:src/b.py");
    expect(links[0]!.support).toBe(5);
    expect(links[0]!.confidence).toBe(0.8); // strongest of the two directions
  });

  it("rolls links up to a visible directory representative when files are collapsed", () => {
    const m = model();
    const cochange: CochangeMap = {
      "src/a.py": [{ path: "src/b.py", support: 3, confidence: 0.5 }],
    };
    // Only the src dir is visible (files collapsed) → both endpoints roll up to
    // the same dir representative → self-link → dropped.
    const visible = new Set(["dir:r:src"]);
    const links = buildCouplingLinks(m, cochange, visible);
    expect(links).toHaveLength(0);
  });

  it("ignores co-change for paths with no matching file cluster", () => {
    const m = model();
    const cochange: CochangeMap = {
      "src/a.py": [{ path: "does/not/exist.py", support: 9, confidence: 1 }],
    };
    const visible = new Set(["file:r:src/a.py", "file:r:src/b.py"]);
    expect(buildCouplingLinks(m, cochange, visible)).toHaveLength(0);
  });

  it("returns nothing for an empty co-change map", () => {
    const m = model();
    const visible = new Set(["file:r:src/a.py"]);
    expect(buildCouplingLinks(m, {}, visible)).toEqual([]);
  });
});
