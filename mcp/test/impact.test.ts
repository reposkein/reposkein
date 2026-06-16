import { describe, it, expect, vi } from "vitest";
import { isTestPath, computeImpact } from "../src/profile/impact.js";
import { fakeStore } from "./fakeStore.js";
import type { NeighborRow, GraphStore } from "../src/store/GraphStore.js";
import type { TargetRow } from "../src/profile/types.js";

// ---------------------------------------------------------------------------
// isTestPath unit cases
// ---------------------------------------------------------------------------
describe("isTestPath", () => {
  it("tests/ directory segment → true", () => {
    expect(isTestPath("tests/foo.py")).toBe(true);
  });

  it("test/ directory segment → true", () => {
    expect(isTestPath("src/test/helpers.py")).toBe(true);
  });

  it("_test. basename suffix → true (Go convention)", () => {
    expect(isTestPath("src/foo_test.go")).toBe(true);
  });

  it("FooTest.java → true (Java case-sensitive convention)", () => {
    expect(isTestPath("src/FooTest.java")).toBe(true);
  });

  it("FooTests.java → true", () => {
    expect(isTestPath("src/FooTests.java")).toBe(true);
  });

  it("FooTests.cs → true (C# convention)", () => {
    expect(isTestPath("src/MyLib.Tests/FooTests.cs")).toBe(true);
  });

  it(".tests. project segment → true (C# .Tests.cs)", () => {
    expect(isTestPath("src/Foo.tests.cs")).toBe(true);
  });

  it(".test. basename → true", () => {
    expect(isTestPath("src/foo.test.ts")).toBe(true);
  });

  it(".spec. basename → true", () => {
    expect(isTestPath("src/foo.spec.ts")).toBe(true);
  });

  it("test_ prefix on basename → true", () => {
    expect(isTestPath("src/test_utils.py")).toBe(true);
  });

  it("contest_results.py → false (no false positive)", () => {
    expect(isTestPath("src/contest_results.py")).toBe(false);
  });

  it("plain source file → false", () => {
    expect(isTestPath("src/a.ts")).toBe(false);
  });

  it("Contest.java → false (case-sensitive: not Test.java suffix)", () => {
    expect(isTestPath("src/main/java/com/acme/Contest.java")).toBe(false);
  });

  it("Service.java → false", () => {
    expect(isTestPath("src/main/java/com/acme/Service.java")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helper to build a TargetRow for fakeStore
// ---------------------------------------------------------------------------
function makeTargetRow(
  id: string,
  qualifiedName: string,
  filePath: string,
  repoId = "repo1",
): TargetRow {
  return {
    id,
    repo_id: repoId,
    name: qualifiedName,
    qualified_name: qualifiedName,
    file_path: filePath,
    start_line: 1,
    end_line: 10,
    semantic_summary: null,
    summary_of_hash: null,
    content_hash: null,
    labels: ["Function"],
  };
}

function makeNeighborRow(id: string, name: string): NeighborRow {
  return {
    id,
    name,
    semantic_summary: null,
    summary_of_hash: null,
    content_hash: null,
  };
}

// ---------------------------------------------------------------------------
// Graph fixture:
//   t() -> a() -> b()
//   test_t() (in tests/) calls t()
//
// Changing b(): impacted = [a, t] (sorted depth asc, id asc)
//               covering_tests = [test_t]
// ---------------------------------------------------------------------------
describe("computeImpact", () => {
  const B_ID = "repo1:func:src/b.py#b@0";
  const A_ID = "repo1:func:src/a.py#a@0";
  const T_ID = "repo1:func:src/t.py#t@0";
  const TEST_T_ID = "repo1:func:tests/test_t.py#test_t@0";

  // callers: b → [a]; a → [t]; t → [test_t]; test_t → []
  const callersMap: Record<string, NeighborRow[]> = {
    [B_ID]: [makeNeighborRow(A_ID, "a")],
    [A_ID]: [makeNeighborRow(T_ID, "t")],
    [T_ID]: [makeNeighborRow(TEST_T_ID, "test_t")],
    [TEST_T_ID]: [],
  };

  const nodesMap: Record<string, TargetRow> = {
    [B_ID]: makeTargetRow(B_ID, "b", "src/b.py"),
    [A_ID]: makeTargetRow(A_ID, "a", "src/a.py"),
    [T_ID]: makeTargetRow(T_ID, "t", "src/t.py"),
    [TEST_T_ID]: makeTargetRow(TEST_T_ID, "test_t", "tests/test_t.py"),
  };

  function makeFixtureStore(): GraphStore {
    return fakeStore({
      callers: vi.fn(async (_repoIds: string[], id: string, _limit: number) => {
        return callersMap[id] ?? [];
      }),
      getNode: vi.fn(async (_repoIds: string[], id: string) => {
        return nodesMap[id] ?? null;
      }),
    });
  }

  it("impacted=[a,t] covering_tests=[test_t] when changing b", async () => {
    const store = makeFixtureStore();
    const result = await computeImpact(store, ["repo1"], B_ID, "b", "src/b.py", {
      depth: 3,
      maxNodes: 500,
    });

    expect(result.target.node_id).toBe(B_ID);
    expect(result.impacted.map((r) => r.node_id)).toEqual([A_ID, T_ID]);
    expect(result.covering_tests.map((r) => r.node_id)).toEqual([TEST_T_ID]);
    expect(result.counts.impacted).toBe(2);
    expect(result.counts.covering_tests).toBe(1);
    expect(result.counts.truncated).toBe(false);
  });

  it("impacted is sorted depth asc, then node_id asc", async () => {
    const store = makeFixtureStore();
    const result = await computeImpact(store, ["repo1"], B_ID, "b", "src/b.py", {
      depth: 3,
      maxNodes: 500,
    });

    const depths = result.impacted.map((r) => r.depth);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]!).toBeGreaterThanOrEqual(depths[i - 1]!);
    }
  });

  it("is deterministic: two runs produce identical output", async () => {
    const store1 = makeFixtureStore();
    const store2 = makeFixtureStore();
    const r1 = await computeImpact(store1, ["repo1"], B_ID, "b", "src/b.py", {
      depth: 3,
      maxNodes: 500,
    });
    const r2 = await computeImpact(store2, ["repo1"], B_ID, "b", "src/b.py", {
      depth: 3,
      maxNodes: 500,
    });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it("depth cap: depth=1 only returns direct callers of b", async () => {
    const store = makeFixtureStore();
    const result = await computeImpact(store, ["repo1"], B_ID, "b", "src/b.py", {
      depth: 1,
      maxNodes: 500,
    });

    // Only a() is a direct caller of b(); t() and test_t() are deeper
    expect(result.impacted.map((r) => r.node_id)).toEqual([A_ID]);
    expect(result.covering_tests).toHaveLength(0);
  });

  it("truncated flag set when maxNodes is hit", async () => {
    // maxNodes=1 means we stop after adding 1 node beyond the target
    const store = makeFixtureStore();
    const result = await computeImpact(store, ["repo1"], B_ID, "b", "src/b.py", {
      depth: 5,
      maxNodes: 1,
    });

    expect(result.counts.truncated).toBe(true);
    // Only a() should be included (the first caller discovered)
    const allIds = [
      ...result.impacted.map((r) => r.node_id),
      ...result.covering_tests.map((r) => r.node_id),
    ];
    expect(allIds).toHaveLength(1);
  });

  it("covering_tests have is_test=true, impacted have is_test=false", async () => {
    const store = makeFixtureStore();
    const result = await computeImpact(store, ["repo1"], B_ID, "b", "src/b.py", {
      depth: 3,
      maxNodes: 500,
    });

    for (const row of result.impacted) {
      expect(row.is_test).toBe(false);
    }
    for (const row of result.covering_tests) {
      expect(row.is_test).toBe(true);
    }
  });
});
