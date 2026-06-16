import { describe, it, expect } from "vitest";
import { computeImpact } from "./impact";
import { isTestPath, isTestNode } from "./classify";
import type { ClientModel } from "./clientModel";
import type { DrawEdge, NodeRecord } from "./model";

function rec(id: string, filePath: string, role = ""): NodeRecord {
  return {
    id,
    name: id,
    qualifiedName: id,
    kind: "Function",
    filePath,
    startLine: 0,
    endLine: 0,
    language: "",
    role,
    semanticSummary: null,
    summaryOfHash: null,
    contentHash: null,
    degree: 0,
  };
}

function edge(from: string, to: string, type = "CALLS"): DrawEdge {
  return { from, to, type, resolution: "exact", confidence: 1, crossRepo: false };
}

/** Minimal ClientModel carrying only what computeImpact reads. */
function model(records: NodeRecord[], drawEdges: DrawEdge[]): ClientModel {
  return {
    drawEdges,
    records: new Map(records.map((r) => [r.id, r])),
  } as unknown as ClientModel;
}

describe("test classification", () => {
  it("matches common test file conventions", () => {
    expect(isTestPath("src/foo_test.py")).toBe(true);
    expect(isTestPath("src/test_foo.py")).toBe(true);
    expect(isTestPath("pkg/handler_test.go")).toBe(true);
    expect(isTestPath("crates/x/src/lib_test.rs")).toBe(true);
    expect(isTestPath("app/Button.test.ts")).toBe(true);
    expect(isTestPath("app/Button.spec.tsx")).toBe(true);
    expect(isTestPath("com/acme/FooTest.java")).toBe(true);
    expect(isTestPath("Acme/FooTests.cs")).toBe(true);
    expect(isTestPath("tests/integration/run.py")).toBe(true);
    expect(isTestPath("src/__tests__/x.ts")).toBe(true);
  });

  it("does not flag ordinary source files", () => {
    expect(isTestPath("src/foo.py")).toBe(false);
    expect(isTestPath("app/Button.ts")).toBe(false);
    expect(isTestPath("src/contestant.py")).toBe(false); // "test" substring, not a segment
    expect(isTestPath("")).toBe(false);
  });

  it("treats role=testing as a test signal regardless of path", () => {
    expect(isTestNode({ filePath: "src/foo.py", role: "testing" })).toBe(true);
    expect(isTestNode({ filePath: "src/foo.py", role: "" })).toBe(false);
  });
});

describe("impact BFS (reverse-CALLS transitive callers + covering tests)", () => {
  it("collects transitive callers and excludes the source", () => {
    // c -> b -> a   (a is the target; callers are b then transitively c)
    const m = model(
      [rec("a", "src/a.ts"), rec("b", "src/b.ts"), rec("c", "src/c.ts")],
      [edge("b", "a"), edge("c", "b")]
    );
    const r = computeImpact(m, "a");
    expect([...r.impacted].sort()).toEqual(["b", "c"]);
    expect(r.impacted.has("a")).toBe(false);
    expect(r.coveringTests.size).toBe(0);
  });

  it("identifies covering tests among the transitive callers", () => {
    // t (test) -> b -> a ; t is a covering test of a.
    const m = model(
      [rec("a", "src/a.ts"), rec("b", "src/b.ts"), rec("t", "src/a.test.ts")],
      [edge("b", "a"), edge("t", "b")]
    );
    const r = computeImpact(m, "a");
    expect([...r.impacted].sort()).toEqual(["b", "t"]);
    expect([...r.coveringTests]).toEqual(["t"]);
  });

  it("ignores non-CALLS edges", () => {
    const m = model(
      [rec("a", "src/a.ts"), rec("b", "src/b.ts")],
      [edge("b", "a", "IMPORTS")]
    );
    const r = computeImpact(m, "a");
    expect(r.impacted.size).toBe(0);
  });

  it("handles cycles without looping forever", () => {
    const m = model(
      [rec("a", "src/a.ts"), rec("b", "src/b.ts")],
      [edge("b", "a"), edge("a", "b")]
    );
    const r = computeImpact(m, "a");
    expect([...r.impacted]).toEqual(["b"]);
  });
});
