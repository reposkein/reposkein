import { describe, it, expect } from "vitest";
import { drainIndexLock, isIndexLockHeld, withIndexLock } from "../src/indexer/indexLock.js";
import { spawnIndexer } from "../src/indexer/runIndexer.js";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("withIndexLock", () => {
  it("serializes overlapping bodies (no interleaving)", async () => {
    const events: string[] = [];
    const body = async (name: string): Promise<void> => {
      events.push(`enter ${name}`);
      await tick();
      await tick();
      events.push(`exit ${name}`);
    };
    // Started together, deliberately un-awaited until both are queued.
    await Promise.all([
      withIndexLock(() => body("a")),
      withIndexLock(() => body("b")),
      withIndexLock(() => body("c")),
    ]);
    // Every exit immediately follows its own enter: no run overlapped another.
    expect(events).toEqual([
      "enter a",
      "exit a",
      "enter b",
      "exit b",
      "enter c",
      "exit c",
    ]);
  });

  it("runs waiters in arrival order (a fast poller cannot starve a tool call)", async () => {
    const order: string[] = [];
    await Promise.all(
      ["first", "second", "third"].map((n) =>
        withIndexLock(async () => {
          order.push(n);
          await tick();
        })
      )
    );
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("is reentrant: a nested acquisition does not deadlock", async () => {
    const result = await withIndexLock(async () => {
      // This is what makes putting the lock inside `spawnIndexer` safe: any
      // future operation that wraps itself AND spawns would otherwise wedge
      // the whole process against its own lock.
      return withIndexLock(async () => "inner ran");
    });
    expect(result).toBe("inner ran");
  });

  it("reports held while a run is in progress or queued, and clears after", async () => {
    expect(isIndexLockHeld()).toBe(false);
    let seenInside = false;
    let seenByWaiter = false;
    const holder = withIndexLock(async () => {
      seenInside = isIndexLockHeld();
      await tick();
    });
    // A queued waiter counts too — that is what lets the watcher skip rather
    // than pile a redundant index behind a tool call.
    const waiter = withIndexLock(async () => {
      seenByWaiter = isIndexLockHeld();
    });
    expect(isIndexLockHeld()).toBe(true);
    await Promise.all([holder, waiter]);
    expect(seenInside).toBe(true);
    expect(seenByWaiter).toBe(true);
    expect(isIndexLockHeld()).toBe(false);
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withIndexLock(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(isIndexLockHeld()).toBe(false);
    // And the queue still works afterwards.
    expect(await withIndexLock(async () => "after")).toBe("after");
  });
});

describe("spawnIndexer — the lock is on the choke point, not the call sites", () => {
  it("serializes two concurrent spawns", async () => {
    // A real spawn through the real function: this is the assertion that
    // EVERY indexer invocation is serialized, including any added later,
    // because none of them can reach the process without passing through here.
    const busyFor = 120;
    const prog = `const t=Date.now();while(Date.now()-t<${busyFor});process.stdout.write(String(Date.now()));`;
    const run = async (): Promise<{ start: number; end: number }> => {
      const start = Date.now();
      const r = await spawnIndexer(process.execPath, ["-e", prog]);
      expect(r.code).toBe(0);
      return { start, end: Date.now() };
    };
    const [a, b] = await Promise.all([run(), run()]);
    // Whichever went second cannot have started before the first finished.
    const [first, second] = a.start <= b.start ? [a, b] : [b, a];
    expect(second.end).toBeGreaterThanOrEqual(first.end);
    // And the total is two busy-waits, not one — they did not overlap.
    const total = Math.max(a.end, b.end) - Math.min(a.start, b.start);
    expect(total).toBeGreaterThanOrEqual(busyFor * 2 * 0.75);
    await drainIndexLock();
  }, 20_000);
});
