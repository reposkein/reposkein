import { describe, it, expect, vi } from "vitest";
import { startHeadWatcher, watchTick, type WatchDeps } from "../src/serve/watch.js";
import { parseServeArgs } from "../src/serve/serve.js";

/** A fake checkout: HEAD moves when the test says so, and `reindex` advances
 *  the indexed-at marker exactly the way the real one does (it writes the
 *  marker from HEAD), so idempotence is tested against the real contract. */
function fakeRepo(head: string | null, indexed: string | null) {
  const state = { head, indexed, reindexes: 0, fail: false as boolean };
  const logs: string[] = [];
  const deps: WatchDeps = {
    headSha: () => state.head,
    indexedSha: () => state.indexed,
    reindex: async () => {
      state.reindexes++;
      if (state.fail) return { ok: false, error: "indexer exploded" };
      state.indexed = state.head;
      return { ok: true, nodes: 7, edges: 3 };
    },
    log: (m) => logs.push(m),
  };
  return { state, logs, deps };
}

describe("watchTick — idempotence", () => {
  it("does no work when HEAD already equals the indexed-at marker", async () => {
    const { state, logs, deps } = fakeRepo("a".repeat(40), "a".repeat(40));
    expect(await watchTick(deps)).toBe("unchanged");
    expect(state.reindexes).toBe(0);
    expect(logs).toEqual([]);
  });

  it("re-indexes exactly once for a new HEAD, then goes quiet", async () => {
    const { state, logs, deps } = fakeRepo("b".repeat(40), "a".repeat(40));
    expect(await watchTick(deps)).toBe("reindexed");
    expect(state.reindexes).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("reindexed at HEAD bbbbbbbbbbbb");
    expect(logs[0]).toContain("7 nodes, 3 edges");

    expect(await watchTick(deps)).toBe("unchanged");
    expect(state.reindexes).toBe(1);
    expect(logs).toHaveLength(1);
  });

  it("treats a never-indexed checkout (no marker) as needing one index", async () => {
    const { state, deps } = fakeRepo("c".repeat(40), null);
    expect(await watchTick(deps)).toBe("reindexed");
    expect(state.reindexes).toBe(1);
    expect(await watchTick(deps)).toBe("unchanged");
  });

  it("keeps serving the old graph on failure and retries on the next tick", async () => {
    const { state, logs, deps } = fakeRepo("d".repeat(40), "a".repeat(40));
    state.fail = true;
    expect(await watchTick(deps)).toBe("failed");
    expect(logs[0]).toContain("FAILED");
    expect(logs[0]).toContain("indexer exploded");
    // The marker was NOT advanced, so the next tick tries again.
    state.fail = false;
    expect(await watchTick(deps)).toBe("reindexed");
    expect(state.reindexes).toBe(2);
  });

  it("does nothing when the served directory has no git HEAD", async () => {
    const { state, deps } = fakeRepo(null, null);
    expect(await watchTick(deps)).toBe("no-head");
    expect(state.reindexes).toBe(0);
  });
});

describe("startHeadWatcher", () => {
  it("polls, fires onReindexed once, and stops cleanly", async () => {
    const { state, deps } = fakeRepo("e".repeat(40), "a".repeat(40));
    let refreshes = 0;
    const watcher = startHeadWatcher("/nonexistent", "repo", {
      intervalMs: 5,
      deps,
      onReindexed: () => refreshes++,
    });
    try {
      await vi.waitFor(() => expect(state.reindexes).toBe(1), { timeout: 2000 });
      await vi.waitFor(() => expect(refreshes).toBe(1), { timeout: 2000 });
    } finally {
      watcher.stop();
    }
    const after = state.reindexes;
    await new Promise((r) => setTimeout(r, 40));
    // Stopped means stopped: HEAD is unchanged now anyway, but the point is
    // that no further ticks run at all.
    expect(state.reindexes).toBe(after);
  });

  it("with intervalMs 0 never polls, but a manual tick still works", async () => {
    const { state, deps } = fakeRepo("f".repeat(40), "a".repeat(40));
    const watcher = startHeadWatcher("/nonexistent", "repo", { intervalMs: 0, deps });
    await new Promise((r) => setTimeout(r, 30));
    expect(state.reindexes).toBe(0);
    expect(await watcher.tick()).toBe("reindexed");
    watcher.stop();
  });
});

describe("parseServeArgs", () => {
  it("defaults to loopback, no --http, and a 30s poll", () => {
    const { repoPath, opts, http } = parseServeArgs([]);
    expect(http).toBe(false);
    expect(opts).toEqual({ port: 4318, host: "127.0.0.1", watchIntervalMs: 30_000 });
    expect(repoPath).toBe(process.env.REPOSKEIN_REPO_PATH ?? ".");
  });

  it("parses --http, both flag spellings, and seconds-to-ms for the interval", () => {
    const a = parseServeArgs(["--http", "--port", "9000", "--host", "0.0.0.0", "--watch-interval", "5", "/repo"]);
    expect(a.http).toBe(true);
    expect(a.opts).toEqual({ port: 9000, host: "0.0.0.0", watchIntervalMs: 5000 });
    expect(a.repoPath).toBe("/repo");

    const b = parseServeArgs(["--http", "--port=9001", "--host=1.2.3.4", "--watch-interval=0"]);
    expect(b.opts).toEqual({ port: 9001, host: "1.2.3.4", watchIntervalMs: 0 });
  });

  it("falls back to defaults for garbage numeric flags rather than NaN", () => {
    const { opts } = parseServeArgs(["--port", "notanumber", "--watch-interval", "-3"]);
    expect(opts.port).toBe(4318);
    expect(opts.watchIntervalMs).toBe(30_000);
  });
});
