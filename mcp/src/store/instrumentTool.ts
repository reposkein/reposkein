import { AsyncLocalStorage } from "node:async_hooks";
import type { RepoResolution } from "./resolveRepoPath.js";
import type { RepoSession } from "./repoSession.js";
import { argsShapeOf, extractTouchedIds, resultByteSize, type SessionLogger, type ToolResultLike } from "./sessionLog.js";

interface CallCache {
  value?: RepoResolution;
}

export interface ToolLogger {
  /** `session.resolve()`, memoized for the lifetime of the CURRENT tool
   *  call (see `withLog`) — a handler that calls this (directly, or via
   *  `resolveActiveRepo`) and the logging wrapper both see the same
   *  filesystem walk, not two. Isolated per call via AsyncLocalStorage, so
   *  concurrent/overlapping tool calls never share a cached value. Falls
   *  back to a plain, uncached `session.resolve()` when called outside any
   *  `withLog`-wrapped call (e.g. server startup). */
  cachedResolve(): RepoResolution;
  /** Wraps a tool handler so its call is logged to the active repo's
   *  session log — see sessionLog.ts. `Args`/result type are inferred from
   *  the handler passed in, so call sites (`server.registerTool(name,
   *  config, withLog(name, async (args) => {...}))`) need no extra typing. */
  withLog<Args, R extends ToolResultLike>(name: string, cb: (args: Args) => Promise<R>): (args: Args) => Promise<R>;
}

/** Builds the tool-call instrumentation for one MCP server connection: one
 *  `ToolLogger` shared across every `server.registerTool` call (REP-20).
 *
 *  Two hot-path fixes from review round 1, both scoped to this module so
 *  they're covered without spinning up the whole server:
 *
 *  1. Single resolution per call — `cachedResolve()` memoizes
 *     `session.resolve()` per call (AsyncLocalStorage-scoped), so a
 *     handler's own resolution (via `resolveActiveRepo`, or a direct
 *     `cachedResolve()` call for the couple of tools that don't gate on a
 *     full repo context) and the logging wrapper's resolution are the same
 *     filesystem walk, not two.
 *  2. Deferred write — the `finally` block below only captures cheap,
 *     already-computed references synchronously (tool name, argsShape, the
 *     resolved repo path, the result object BY REFERENCE, ok, ts) and
 *     returns immediately; JSON-parsing the result for `extractTouchedIds`
 *     and the actual file write happen in a `schedule()`-deferred callback
 *     (default `setImmediate`), which runs only after the response has
 *     already been handed back to the MCP transport. The deferred callback
 *     swallows every error itself — it must never surface as an unhandled
 *     exception/rejection. */
export function createToolLogger(
  session: RepoSession,
  sessionLogger: SessionLogger,
  schedule: (fn: () => void) => void = setImmediate
): ToolLogger {
  const als = new AsyncLocalStorage<CallCache>();

  function cachedResolve(): RepoResolution {
    const store = als.getStore();
    if (!store) return session.resolve();
    if (!store.value) store.value = session.resolve();
    return store.value;
  }

  function deferredLog(
    ts: string,
    repoPath: string,
    tool: string,
    argsShape: string[],
    ok: boolean,
    result: ToolResultLike | undefined
  ): void {
    schedule(() => {
      try {
        const resultBytes = resultByteSize(result);
        const nodeIds = extractTouchedIds(result);
        sessionLogger.logAt(ts, repoPath, {
          tool,
          argsShape,
          resultBytes,
          ...(nodeIds.length ? { nodeIds } : {}),
          ok,
        });
      } catch {
        // deferred logging must never surface as an unhandled exception
      }
    });
  }

  function withLog<Args, R extends ToolResultLike>(
    name: string,
    cb: (args: Args) => Promise<R>
  ): (args: Args) => Promise<R> {
    return (args: Args): Promise<R> =>
      als.run({}, async () => {
        let result: R | undefined;
        let threw = false;
        try {
          result = await cb(args);
          return result;
        } catch (err) {
          threw = true;
          throw err;
        } finally {
          // Cheap, synchronous capture only — no JSON.parse, no fs calls on
          // the hot path. `result` is captured BY REFERENCE; it isn't read
          // until the deferred callback runs.
          try {
            const resolution = cachedResolve();
            if (resolution.repoPath) {
              deferredLog(
                new Date().toISOString(),
                resolution.repoPath,
                name,
                argsShapeOf(args),
                !threw && (result as ToolResultLike | undefined)?.isError !== true,
                result
              );
            }
          } catch {
            // instrumentation must never affect the tool call
          }
        }
      });
  }

  return { cachedResolve, withLog };
}
