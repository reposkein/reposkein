import { execFileSync } from "node:child_process";
import { readIndexedAtSha, writeIndexedAtMarker } from "../store/indexedAt.js";
import { ensureIndexerBinary } from "../indexer/fetchBinary.js";
import { spawnIndexer, parseJsonStats } from "../indexer/runIndexer.js";
import { isIndexLockHeld } from "../indexer/indexLock.js";

/** What one watch tick did. `unchanged` is the overwhelmingly common case and
 *  costs exactly one `git rev-parse` — the whole point of comparing against
 *  the indexed-at marker rather than re-indexing on a timer. `locked` means
 *  another indexer run (a write-capable tool call, or the previous tick) owns
 *  the index lock; the tick is skipped, not queued. */
export type WatchOutcome = "unchanged" | "reindexed" | "failed" | "no-head" | "locked";

export interface ReindexResult {
  ok: boolean;
  nodes?: number;
  edges?: number;
  error?: string;
}

export interface WatchDeps {
  /** Current git HEAD of the served checkout, or null (not a repo / no HEAD). */
  headSha: () => string | null;
  /** The SHA the graph was last built from (`.reposkein/local/indexed-at`). */
  indexedSha: () => string | null;
  /** Rebuild the graph. MUST also refresh the indexed-at marker on success. */
  reindex: () => Promise<ReindexResult>;
  /** Where the one-line-per-reindex summary goes. MUST NOT be stdout in stdio
   *  mode; `serve` has no stdio transport, but stderr stays the convention. */
  log: (message: string) => void;
  /** Whether an indexer run is already in progress or queued. Injectable so
   *  the skip path is testable without spawning anything. */
  indexBusy: () => boolean;
}

/** Reads HEAD of `repoPath`, or null. Never throws. */
export function gitHeadSha(repoPath: string): string | null {
  try {
    const sha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** One watch tick.
 *
 *  Idempotence is structural, not statistical: the decision to do work is
 *  `HEAD !== indexed-at`, and the marker is written from HEAD by the index
 *  step itself. So a tick against an unchanged checkout does nothing at all
 *  (no indexer spawn, no log line), and a tick after `git pull` does exactly
 *  one re-index — including across a server restart, because the marker is on
 *  disk. If HEAD moves again DURING an index, the marker records the SHA that
 *  was current when the index finished and the next tick converges.
 *
 *  Reusing REP-16's marker (rather than an in-memory "last seen" SHA) is what
 *  keeps `doctor --ci`'s `graph_stale` check agreeing with the watcher: both
 *  read the same file. */
export async function watchTick(deps: WatchDeps): Promise<WatchOutcome> {
  const head = deps.headSha();
  if (!head) return "no-head";
  if (head === deps.indexedSha()) return "unchanged";
  // Someone else is indexing (a write tool call, or a still-running earlier
  // tick). SKIP rather than queue: whatever they are building is being built
  // from the same working tree, so by the time the lock frees, this tick's
  // work is either done or the next tick will see it needs doing. Queueing
  // here would fire a redundant full index behind every write tool call.
  if (deps.indexBusy()) return "locked";
  const started = Date.now();
  const r = await deps.reindex();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const short = head.slice(0, 12);
  if (!r.ok) {
    deps.log(
      `reposkein serve: reindex for HEAD ${short} FAILED after ${secs}s: ${r.error ?? "unknown error"} ` +
        "(serving the previous graph; will retry on the next tick)"
    );
    return "failed";
  }
  deps.log(
    `reposkein serve: reindexed at HEAD ${short} in ${secs}s ` +
      `(${r.nodes ?? "?"} nodes, ${r.edges ?? "?"} edges)`
  );
  return "reindexed";
}

/** The default `reindex`: the same indexer invocation `reposkein-mcp index`
 *  uses, followed by the indexed-at marker write. */
export function makeDefaultReindex(repoPath: string, repoId: string): () => Promise<ReindexResult> {
  return async (): Promise<ReindexResult> => {
    try {
      const bin = await ensureIndexerBinary();
      const r = await spawnIndexer(bin, ["index", "--json", "--repo-id", repoId, repoPath]);
      if (r.code !== 0) {
        return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `exit ${r.code}` };
      }
      const stats = parseJsonStats(r.stdout);
      writeIndexedAtMarker(repoPath);
      return stats ? { ok: true, nodes: stats.nodes, edges: stats.edges } : { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

export interface HeadWatcherOptions {
  intervalMs: number;
  log?: (message: string) => void;
  /** Called after a successful re-index — `serve` uses it to rebuild the
   *  `/api/*` handler, whose node/edge counts and git metadata are computed
   *  once per handler. */
  onReindexed?: () => void;
  /** Test seam: replaces the git + indexer plumbing wholesale. */
  deps?: Partial<WatchDeps>;
}

export interface HeadWatcher {
  /** Runs one tick now (awaitable — used by the startup catch-up and tests). */
  tick: () => Promise<WatchOutcome>;
  stop: () => void;
}

/** Polls `git rev-parse HEAD` on an interval and re-indexes when it moves.
 *
 *  A poll, not a filesystem watcher: the indexer's determinism guarantee is
 *  defined against committed state, and an fs watcher would fire on every
 *  editor save — re-indexing mid-edit, repeatedly, for a graph nobody asked
 *  for yet. A poll also covers the case that actually matters for a shared
 *  server (someone ran `git fetch && git reset --hard` in the checkout, or a
 *  deploy hook did) without requiring a hook to be installed at all.
 *
 *  `intervalMs <= 0` disables polling entirely; `tick()` still works, so an
 *  operator can drive re-indexing from their own post-receive hook by
 *  restarting or by running `reposkein-mcp index`. */
export function startHeadWatcher(
  repoPath: string,
  repoId: string,
  opts: HeadWatcherOptions
): HeadWatcher {
  const log = opts.log ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const deps: WatchDeps = {
    headSha: opts.deps?.headSha ?? (() => gitHeadSha(repoPath)),
    indexedSha: opts.deps?.indexedSha ?? (() => readIndexedAtSha(repoPath)),
    reindex: opts.deps?.reindex ?? makeDefaultReindex(repoPath, repoId),
    log: opts.deps?.log ?? log,
    indexBusy: opts.deps?.indexBusy ?? isIndexLockHeld,
  };

  // Ticks never overlap: a slow index on a big repo must not stack up behind
  // a fast interval, and two concurrent indexer runs on one checkout would
  // race on the same output files.
  let busy = false;
  let stopped = false;

  const tick = async (): Promise<WatchOutcome> => {
    if (stopped) return "unchanged";
    // A previous tick is still running (slow index on a big repo, fast
    // interval). Same reasoning as the index-lock skip in `watchTick`.
    if (busy) return "locked";
    busy = true;
    try {
      const outcome = await watchTick(deps);
      if (outcome === "reindexed") opts.onReindexed?.();
      return outcome;
    } finally {
      busy = false;
    }
  };

  const timer =
    opts.intervalMs > 0
      ? setInterval(() => {
          void tick();
        }, opts.intervalMs)
      : null;

  return {
    tick,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
