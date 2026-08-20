import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeCache } from "../src/store/repoContextCache.js";
import { resolveRepoId } from "../src/store/repoId.js";

describe("makeCache", () => {
  it("caches a value the predicate accepts (compute runs once)", async () => {
    let calls = 0;
    const cached = makeCache(
      async (key: string) => {
        calls++;
        return `value-for-${key}`;
      },
      () => true
    );
    expect(await cached("a")).toBe("value-for-a");
    expect(await cached("a")).toBe("value-for-a");
    expect(await cached("a")).toBe("value-for-a");
    expect(calls).toBe(1);
  });

  it("never caches a value the predicate rejects — compute reruns every call", async () => {
    let calls = 0;
    const cached = makeCache(
      async (key: string) => {
        calls++;
        return { ok: false, key };
      },
      (v) => v.ok
    );
    await cached("a");
    await cached("a");
    await cached("a");
    expect(calls).toBe(3);
  });

  it("keys are independent (a miss on one key doesn't evict another)", async () => {
    let calls = 0;
    const cached = makeCache(
      async (key: string) => {
        calls++;
        return `v-${key}`;
      },
      () => true
    );
    await cached("a");
    await cached("b");
    await cached("a");
    expect(calls).toBe(2);
  });

  it("starts retrying, then locks in once the predicate starts accepting", async () => {
    let calls = 0;
    const cached = makeCache(
      async (key: string) => {
        calls++;
        // "fails" (not cache-worthy) for the first 2 calls, then "succeeds".
        return { ok: calls >= 3, key, call: calls };
      },
      (v) => v.ok
    );
    const first = await cached("a");
    expect(first.ok).toBe(false);
    const second = await cached("a");
    expect(second.ok).toBe(false);
    expect(calls).toBe(2); // recomputed, not cached
    const third = await cached("a");
    expect(third.ok).toBe(true);
    expect(calls).toBe(3);
    // Now cached — a 4th call must NOT invoke compute again.
    const fourth = await cached("a");
    expect(fourth).toBe(third); // same cached object, no recompute
    expect(calls).toBe(3);
  });
});

/** Realistic version of the same scenario, against the real `resolveRepoId`
 *  and a real filesystem fixture — this is the exact bug: index.ts's
 *  getRepoContext used to cache a repo path whose `.reposkein/` exists but
 *  has no meta.json yet (repoId resolves to undefined) forever, so an agent
 *  that fixed the repo out-of-band (wrote meta.json / ran `reposkein-mcp
 *  index` in another terminal) stayed stuck until a server restart. */
describe("makeCache + resolveRepoId — failed resolution is retried after the repo becomes valid", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reposkein-cache-retry-"));
    mkdirSync(join(dir, ".reposkein"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolve -> error (no meta.json) -> write meta.json -> same-session call succeeds and then stays cached", async () => {
    let computeCalls = 0;
    const getRepoContext = makeCache(
      async (path: string) => {
        computeCalls++;
        return { repoId: resolveRepoId(path, undefined) };
      },
      (ctx) => !!ctx.repoId
    );

    // 1) Not indexed yet — no meta.json. Resolution fails, not cached.
    const first = await getRepoContext(dir);
    expect(first.repoId).toBeUndefined();
    expect(computeCalls).toBe(1);

    // 2) Out-of-band fix, in the SAME session (no server restart): meta.json
    //    now exists (as `reposkein-mcp index` / init_cpg_skeleton would write).
    writeFileSync(join(dir, ".reposkein", "meta.json"), JSON.stringify({ repo_id: "now-indexed-id" }));

    // 3) The very next call in this session must pick it up — not stay
    //    stuck on the earlier failure.
    const second = await getRepoContext(dir);
    expect(second.repoId).toBe("now-indexed-id");
    expect(computeCalls).toBe(2);

    // 4) And now that it succeeded, it's cached — a third call must not
    //    re-read meta.json from disk again.
    const third = await getRepoContext(dir);
    expect(third.repoId).toBe("now-indexed-id");
    expect(computeCalls).toBe(2);
    expect(third).toBe(second);
  });
});
