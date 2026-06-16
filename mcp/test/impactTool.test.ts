import { describe, it, expect, vi } from "vitest";
import { makeImpact } from "../src/tools/impact.js";
import { fakeStore } from "./fakeStore.js";
import type { NeighborRow } from "../src/store/GraphStore.js";
import type { TargetRow } from "../src/profile/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const REPO = "myrepo";

function makeTargetRow(
  id: string,
  qualifiedName: string,
  filePath: string,
): TargetRow {
  return {
    id,
    repo_id: REPO,
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

// Graph: b() <- a() <- t();   tests/test_t.py::test_t() calls t()
const B_ID = `${REPO}:func:src/b.py#b@0`;
const A_ID = `${REPO}:func:src/a.py#a@0`;
const T_ID = `${REPO}:func:src/t.py#t@0`;
const TEST_T_ID = `${REPO}:func:tests/test_t.py#test_t@0`;

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

function makeFixtureStore() {
  return fakeStore({
    resolveByName: vi.fn(async (_repoIds: string[], name: string) => {
      const rows = Object.values(nodesMap).filter(
        (n) => n.name === name || n.qualified_name === name
      );
      return rows;
    }),
    getNode: vi.fn(async (_repoIds: string[], id: string) => nodesMap[id] ?? null),
    callers: vi.fn(async (_repoIds: string[], id: string, _limit: number) => callersMap[id] ?? []),
    federatedRepoIds: vi.fn(async () => []),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("makeImpact handler", () => {
  it("returns impacted + covering_tests for a known target resolved by name", async () => {
    const store = makeFixtureStore();
    const handler = makeImpact(store, REPO);
    const res = await handler({ name: "b" });

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.target.node_id).toBe(B_ID);
    expect(body.impacted.map((r: { node_id: string }) => r.node_id)).toContain(A_ID);
    expect(body.covering_tests.map((r: { node_id: string }) => r.node_id)).toContain(TEST_T_ID);
    expect(body.counts.truncated).toBe(false);
  });

  it("clamps depth to 1 minimum and 5 maximum", async () => {
    const store = makeFixtureStore();
    const handler = makeImpact(store, REPO);

    // depth=0 should be clamped to 1
    const res1 = await handler({ name: "b", depth: 0 });
    expect(res1.isError).toBeFalsy();
    const body1 = JSON.parse(res1.content[0]!.text);
    expect(body1.depth).toBe(1);

    // depth=10 should be clamped to 5
    const res2 = await handler({ name: "b", depth: 10 });
    expect(res2.isError).toBeFalsy();
    const body2 = JSON.parse(res2.content[0]!.text);
    expect(body2.depth).toBe(5);
  });

  it("returns ambiguous candidates for a name that matches multiple nodes", async () => {
    // Create a store that returns two nodes for the same name
    const ID1 = `${REPO}:func:src/foo.py#bar@0`;
    const ID2 = `${REPO}:func:src/other.py#bar@0`;
    const store = fakeStore({
      resolveByName: vi.fn(async () => [
        makeTargetRow(ID1, "bar", "src/foo.py"),
        makeTargetRow(ID2, "bar", "src/other.py"),
      ]),
      getNode: vi.fn(async () => null),
      callers: vi.fn(async () => []),
      federatedRepoIds: vi.fn(async () => []),
    });

    const handler = makeImpact(store, REPO);
    const res = await handler({ name: "bar" });

    // Should NOT be an error, just return candidates
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.ambiguous).toBe(true);
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates.map((c: { id: string }) => c.id).sort()).toEqual([ID1, ID2].sort());
  });

  it("returns error when target not found", async () => {
    const store = fakeStore({
      resolveByName: vi.fn(async () => []),
      federatedRepoIds: vi.fn(async () => []),
    });
    const handler = makeImpact(store, REPO);
    const res = await handler({ name: "nonexistent" });

    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.error).toMatch(/not found/);
  });

  it("returns error when no selector provided", async () => {
    const store = makeFixtureStore();
    const handler = makeImpact(store, REPO);
    const res = await handler({});

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/provide one of/i);
  });

  it("returns impact by node_id", async () => {
    const store = makeFixtureStore();
    const handler = makeImpact(store, REPO);
    const res = await handler({ node_id: B_ID });

    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.target.node_id).toBe(B_ID);
  });
});
