import { describe, it, expect } from "vitest";
import { ensureGraph, type EnsureDeps, type BuildResult } from "../src/indexer/ensureGraph.js";

/** Records what ensureGraph did, so a test can assert on the build and the log. */
function harness(
  opts: { hasGraph?: boolean; build?: BuildResult } = {}
): { deps: Partial<EnsureDeps>; builds: string[][]; logs: string[] } {
  const builds: string[][] = [];
  const logs: string[] = [];
  let clock = 0;
  return {
    builds,
    logs,
    deps: {
      exists: () => opts.hasGraph ?? false,
      build: async (repoId, repoPath) => {
        builds.push([repoId, repoPath]);
        return opts.build ?? { ok: true, nodes: 10257, edges: 17454 };
      },
      log: (m) => void logs.push(m),
      // 2.0s per call pair: first call 0, second 2000.
      now: () => (clock += 2000) - 2000,
    },
  };
}

const ZERO_INFRA = { mode: "auto", neo4jConfigured: false };

describe("ensureGraph", () => {
  it("builds the graph when a fresh clone has none", async () => {
    const h = harness();
    const outcome = await ensureGraph("/repo", "r", ZERO_INFRA, h.deps);

    expect(outcome).toBe("built");
    expect(h.builds).toEqual([["r", "/repo"]]);
  });

  it("explains the delay before building and reports the result after", async () => {
    // A user watching stderr should understand why the first query is slow,
    // rather than concluding the server hung.
    const h = harness();
    await ensureGraph("/repo", "r", ZERO_INFRA, h.deps);

    expect(h.logs[0]).toMatch(/building it now/);
    expect(h.logs[0]).toMatch(/git-ignored/);
    expect(h.logs[1]).toMatch(/built in 2\.0s/);
    expect(h.logs[1]).toMatch(/10257 nodes, 17454 edges/);
  });

  it("does nothing when the graph is already there", async () => {
    const h = harness({ hasGraph: true });
    const outcome = await ensureGraph("/repo", "r", ZERO_INFRA, h.deps);

    expect(outcome).toBe("present");
    expect(h.builds).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it("leaves an explicit neo4j store alone", async () => {
    const h = harness();
    const outcome = await ensureGraph("/repo", "r", { mode: "neo4j", neo4jConfigured: true }, h.deps);

    expect(outcome).toBe("skipped");
    expect(h.builds).toEqual([]);
  });

  it("does not switch a configured neo4j user onto JSONL in auto mode", async () => {
    // auto prefers JSONL when it exists, so building it here would silently
    // change which backend answers every query.
    const h = harness();
    const outcome = await ensureGraph("/repo", "r", { mode: "auto", neo4jConfigured: true }, h.deps);

    expect(outcome).toBe("skipped");
    expect(h.builds).toEqual([]);
  });

  it("builds in explicit jsonl mode even with a database around", async () => {
    const h = harness();
    const outcome = await ensureGraph("/repo", "r", { mode: "jsonl", neo4jConfigured: true }, h.deps);

    expect(outcome).toBe("built");
  });

  it("skips when there is no repo to index", async () => {
    const h = harness();
    expect(await ensureGraph(undefined, "r", ZERO_INFRA, h.deps)).toBe("skipped");
    expect(await ensureGraph("/repo", undefined, ZERO_INFRA, h.deps)).toBe("skipped");
    expect(h.builds).toEqual([]);
  });

  it("survives a failed build and says how to see the real error", async () => {
    // Startup must not die on an unindexable repo: the server still comes up and
    // every tool reports the missing graph.
    const h = harness({ build: { ok: false, error: "parse error in a.ts" } });
    const outcome = await ensureGraph("/repo", "r", ZERO_INFRA, h.deps);

    expect(outcome).toBe("failed");
    expect(h.logs[1]).toMatch(/parse error in a\.ts/);
    expect(h.logs[1]).toMatch(/reposkein-mcp index \/repo/);
  });
});
