import { AsyncLocalStorage } from "node:async_hooks";

/** Process-wide mutual exclusion for indexer invocations.
 *
 *  Every `reposkein-indexer` run writes into the served checkout's
 *  `.reposkein/` — `nodes.jsonl`, `edges.jsonl`, the committed summary shards,
 *  the pending-drift delta. Two runs at once on one checkout interleave those
 *  writes, and the loser's output is whatever the filesystem happened to
 *  order last. That was survivable while the server was one stdio process
 *  serving one agent: index runs were driven by one caller, one at a time.
 *
 *  `serve --http` (REP-17) removes that accident. A write-capable tool call
 *  (`reindex_file`, `init_cpg_skeleton`, `record_decision`'s pre-stamp
 *  refresh) can now land while the HEAD watcher is mid-reindex, from a
 *  different connection, with no shared call stack to serialize them. So the
 *  serialization has to be explicit and it has to be somewhere no future
 *  caller can forget it — which is inside `spawnIndexer` itself, the single
 *  choke point every invocation passes through.
 *
 *  Reentrancy-safe: a lock holder that (now or later) reaches `spawnIndexer`
 *  again runs straight through instead of deadlocking the process against
 *  itself. FIFO: waiters run in arrival order, so a queued tool call can't be
 *  starved by a fast-polling watcher. */

const reentrant = new AsyncLocalStorage<true>();

/** Tail of the FIFO queue: resolves when every already-queued holder is done. */
let tail: Promise<void> = Promise.resolve();
/** Holders plus waiters. Drives `isIndexLockHeld` (see its doc comment). */
let outstanding = 0;

/** True when an indexer run is in progress OR queued.
 *
 *  Deliberately counts waiters, not just the active holder: the HEAD watcher
 *  uses this to SKIP a tick rather than queue behind a tool call, and a tick
 *  that queued would fire a redundant index the moment the tool's run
 *  finished — for a HEAD the tool's own run has by then already indexed. */
export function isIndexLockHeld(): boolean {
  return outstanding > 0;
}

/** Runs `fn` with exclusive access to the indexer. */
export async function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  // Already ours (a nested spawn inside a lock-holding operation): proceed.
  if (reentrant.getStore()) return fn();

  outstanding++;
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const prior = tail;
  // A rejection can't come from `mine` (release never throws), but chain
  // defensively: a broken tail would wedge every future acquisition.
  tail = prior.then(() => mine).catch(() => undefined);
  try {
    await prior;
    return await reentrant.run(true, fn);
  } finally {
    outstanding--;
    release();
  }
}

/** Test-only: drains the queue so one suite's leftovers can't wedge the next.
 *  Never call this from production code — it does not cancel a running
 *  holder, it only waits for the queue to empty. */
export async function drainIndexLock(): Promise<void> {
  await tail;
}
