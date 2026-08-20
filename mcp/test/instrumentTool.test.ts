import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoSession } from "../src/store/repoSession.js";
import { SessionLogger, sessionLogPath } from "../src/store/sessionLog.js";
import { createToolLogger } from "../src/store/instrumentTool.js";

let dir: string;
let session: RepoSession;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-instrument-"));
  mkdirSync(join(dir, ".reposkein"), { recursive: true });
  session = new RepoSession({ cwd: dir, envRepoPath: undefined });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A `schedule` double that queues deferred callbacks instead of running
 *  them, so tests can assert nothing ran synchronously, then flush
 *  deterministically instead of racing the real event loop. */
function manualScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => queue.push(fn),
    flush: () => {
      const pending = queue.splice(0, queue.length);
      for (const fn of pending) fn();
    },
    pendingCount: () => queue.length,
  };
}

describe("createToolLogger — single resolution per call", () => {
  it("resolves the repo exactly once per call, shared between the handler and the logger", async () => {
    const { schedule, flush } = manualScheduler();
    const logger = new SessionLogger("sess-1");
    const toolLogger = createToolLogger(session, logger, schedule);
    const resolveSpy = vi.spyOn(session, "resolve");

    const handler = async (): Promise<{ content: Array<{ type: string; text: string }> }> => {
      // Simulate what resolveActiveRepo / read_cypher / get_temporal_context
      // do internally: resolve the active repo mid-handler.
      toolLogger.cachedResolve();
      toolLogger.cachedResolve(); // even a handler calling it twice costs one walk
      return { content: [{ type: "text", text: "{}" }] };
    };
    const wrapped = toolLogger.withLog("get_context_profile", handler);

    await wrapped(undefined);
    flush();

    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("still resolves exactly once when the handler never calls cachedResolve itself", async () => {
    const { schedule, flush } = manualScheduler();
    const logger = new SessionLogger("sess-1");
    const toolLogger = createToolLogger(session, logger, schedule);
    const resolveSpy = vi.spyOn(session, "resolve");

    const wrapped = toolLogger.withLog("select_repo", async () => ({ content: [{ type: "text", text: "{}" }] }));
    await wrapped(undefined);
    flush();

    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it("each call gets its own resolution — concurrent/overlapping calls don't share a cache", async () => {
    const { schedule, flush } = manualScheduler();
    const logger = new SessionLogger("sess-1");
    const toolLogger = createToolLogger(session, logger, schedule);
    const resolveSpy = vi.spyOn(session, "resolve");

    const handler = async (): Promise<{ content: Array<{ type: string; text: string }> }> => {
      toolLogger.cachedResolve();
      await Promise.resolve(); // yield, so the two calls interleave
      toolLogger.cachedResolve();
      return { content: [{ type: "text", text: "{}" }] };
    };
    const wrapped = toolLogger.withLog("t", handler);

    await Promise.all([wrapped(undefined), wrapped(undefined)]);
    flush();

    // 2 calls x 1 resolution each = 2, never collapsed across calls, never doubled within one.
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it("cachedResolve falls back to a plain (uncached) resolve() outside any call scope", () => {
    const { schedule } = manualScheduler();
    const logger = new SessionLogger("sess-1");
    const toolLogger = createToolLogger(session, logger, schedule);
    const resolveSpy = vi.spyOn(session, "resolve");

    toolLogger.cachedResolve();
    toolLogger.cachedResolve();

    expect(resolveSpy).toHaveBeenCalledTimes(2); // no ALS scope active -> no memoization
  });
});

describe("createToolLogger — deferred write", () => {
  it("does not write before the handler returns (record construction/write happen off the hot path)", async () => {
    const { schedule, flush, pendingCount } = manualScheduler();
    const logger = new SessionLogger("sess-1");
    const toolLogger = createToolLogger(session, logger, schedule);

    const wrapped = toolLogger.withLog("impact", async () => ({
      content: [{ type: "text", text: JSON.stringify({ node_id: "n1" }) }],
    }));

    await wrapped(undefined);

    // The hot path (await wrapped(...)) has completed, but nothing scheduled
    // via `schedule` has run yet — the write is still pending.
    expect(pendingCount()).toBe(1);
    expect(existsSync(sessionLogPath(dir, "sess-1"))).toBe(false);

    flush();
    expect(existsSync(sessionLogPath(dir, "sess-1"))).toBe(true);
    const rec = JSON.parse(readFileSync(sessionLogPath(dir, "sess-1"), "utf8").trim());
    expect(rec).toMatchObject({ tool: "impact", nodeIds: ["n1"], ok: true });
  });

  it("flows through the default `setImmediate` scheduler end-to-end", async () => {
    const logger = new SessionLogger("sess-2");
    const toolLogger = createToolLogger(session, logger); // default schedule = setImmediate

    const wrapped = toolLogger.withLog("semantic_find", async () => ({ content: [{ type: "text", text: "[]" }] }));
    await wrapped(undefined);

    expect(existsSync(sessionLogPath(dir, "sess-2"))).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve)); // let the deferred write's setImmediate run
    expect(existsSync(sessionLogPath(dir, "sess-2"))).toBe(true);
  });

  it("captures ts synchronously (at call completion), not at deferred-write time", async () => {
    const { schedule, flush } = manualScheduler();
    const logger = new SessionLogger("sess-1");
    const toolLogger = createToolLogger(session, logger, schedule);
    const wrapped = toolLogger.withLog("impact", async () => ({ content: [{ type: "text", text: "{}" }] }));

    const before = new Date();
    await wrapped(undefined);
    // Simulate a delayed flush — ts should still reflect `before`, not now.
    await new Promise((r) => setTimeout(r, 5));
    flush();

    const rec = JSON.parse(readFileSync(sessionLogPath(dir, "sess-1"), "utf8").trim());
    const tsMs = Date.parse(rec.ts);
    expect(tsMs).toBeGreaterThanOrEqual(before.getTime());
    expect(tsMs).toBeLessThan(before.getTime() + 5); // stamped before the artificial delay, not after
  });

  it("still records ok:false and no nodeIds when the handler throws, without throwing itself", async () => {
    const { schedule, flush } = manualScheduler();
    const logger = new SessionLogger("sess-1");
    const toolLogger = createToolLogger(session, logger, schedule);
    const wrapped = toolLogger.withLog("impact", async () => {
      throw new Error("boom");
    });

    await expect(wrapped(undefined)).rejects.toThrow("boom");
    expect(() => flush()).not.toThrow();

    const rec = JSON.parse(readFileSync(sessionLogPath(dir, "sess-1"), "utf8").trim());
    expect(rec).toMatchObject({ tool: "impact", resultBytes: 0, ok: false });
    expect(rec.nodeIds).toBeUndefined();
  });

  it("the deferred callback swallows its own errors — never an unhandled exception", () => {
    const { schedule, flush } = manualScheduler();
    const logger = new SessionLogger("sess-1");
    vi.spyOn(logger, "logAt").mockImplementation(() => {
      throw new Error("disk exploded");
    });
    const toolLogger = createToolLogger(session, logger, schedule);
    const wrapped = toolLogger.withLog("impact", async () => ({ content: [{ type: "text", text: "{}" }] }));

    return wrapped(undefined).then(() => {
      expect(() => flush()).not.toThrow();
    });
  });

  it("skips logging entirely (nothing scheduled) when no repo resolves", async () => {
    const empty = mkdtempSync(join(tmpdir(), "reposkein-instrument-empty-"));
    try {
      const noRepoSession = new RepoSession({ cwd: empty, envRepoPath: undefined });
      const { schedule, pendingCount } = manualScheduler();
      const logger = new SessionLogger("sess-1");
      const toolLogger = createToolLogger(noRepoSession, logger, schedule);
      const wrapped = toolLogger.withLog("impact", async () => ({ content: [{ type: "text", text: "{}" }] }));

      await wrapped(undefined);
      expect(pendingCount()).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
