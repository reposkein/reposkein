import { describe, it, expect } from "vitest";
import { buildClusterTree } from "./cluster";
import { computeLayout } from "./layout";
import { idToPosition, fnv1a, mulberry32 } from "./hash";
import type { RawGraph } from "./types";

function graph(): RawGraph {
  return {
    nodes: [
      { id: "rs1:r:repo:.", labels: ["Repository"], props: { name: "r", is_nested: false } },
      { id: "rs1:r:dir:.", labels: ["Directory"], props: { name: ".", path: "." } },
      { id: "rs1:r:dir:src", labels: ["Directory"], props: { name: "src", path: "src" } },
      { id: "rs1:r:file:src/a.py", labels: ["File"], props: { name: "a.py", path: "src/a.py" } },
      { id: "rs1:r:func:src/a.py#f@1", labels: ["Function"], props: { name: "f", file_path: "src/a.py" } },
      { id: "rs1:r:func:src/a.py#h@2", labels: ["Function"], props: { name: "h", file_path: "src/a.py" } },
    ],
    edges: [
      { from: "rs1:r:file:src/a.py", type: "DEFINES", to: "rs1:r:func:src/a.py#f@1", props: {} },
      { from: "rs1:r:file:src/a.py", type: "DEFINES", to: "rs1:r:func:src/a.py#h@2", props: {} },
    ],
  };
}

describe("deterministic layout", () => {
  it("idToPosition is reproducible and seed-stable", () => {
    expect(idToPosition("abc")).toEqual(idToPosition("abc"));
    expect(idToPosition("abc")).not.toEqual(idToPosition("xyz"));
  });

  it("mulberry32 yields the same sequence for the same seed", () => {
    const a = mulberry32(fnv1a("seed"));
    const b = mulberry32(fnv1a("seed"));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("two layout runs on the same graph yield byte-identical positions", () => {
    const t1 = buildClusterTree(graph());
    const t2 = buildClusterTree(graph());
    const l1 = computeLayout(t1);
    const l2 = computeLayout(t2);

    expect(l1.keys).toEqual(l2.keys);
    expect(l1.positions.length).toBe(l2.positions.length);
    // Byte-for-byte identical Float32Array.
    expect(Array.from(l1.positions)).toEqual(Array.from(l2.positions));
  });

  it("reusing cached positions yields byte-identical output (no-op speed win)", () => {
    const tree = buildClusterTree(graph());
    const fresh = computeLayout(tree);
    // Feed the fresh positions back as the cache: must reproduce them exactly.
    const reused = computeLayout(buildClusterTree(graph()), fresh.positions);
    expect(reused.keys).toEqual(fresh.keys);
    expect(Array.from(reused.positions)).toEqual(Array.from(fresh.positions));
    // The returned buffer is a copy (model owns it), not the same reference.
    expect(reused.positions).not.toBe(fresh.positions);
  });

  it("ignores a cached buffer of the wrong length and recomputes", () => {
    const tree = buildClusterTree(graph());
    const fresh = computeLayout(tree);
    const wrong = new Float32Array(6); // deliberately too short
    const recomputed = computeLayout(buildClusterTree(graph()), wrong);
    expect(Array.from(recomputed.positions)).toEqual(Array.from(fresh.positions));
  });

  it("layout produces a position triple per cluster", () => {
    const tree = buildClusterTree(graph());
    const layout = computeLayout(tree);
    expect(layout.positions.length).toBe(layout.keys.length * 3);
    expect(layout.keys.length).toBe(tree.byKey.size);
    // No NaNs.
    for (const v of layout.positions) expect(Number.isFinite(v)).toBe(true);
  });
});
