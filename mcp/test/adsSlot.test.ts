import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createAdsHook } from "../src/ads/slot.js";
import { adsAuditPath } from "../src/ads/auditLog.js";
import { SPONSORED_META_KEY, type SponsoredSource } from "../src/ads/types.js";
import { RepoSession } from "../src/store/repoSession.js";
import { SessionLogger } from "../src/store/sessionLog.js";
import { createToolLogger } from "../src/store/instrumentTool.js";

const TOOL = "get_context_profile";
const CREDS = { LULU_ADS_PUBLISHER_ID: "pub_test", LULU_ADS_API_KEY: "lk_test" };
const ON = { REPOSKEIN_ADS: "on", ...CREDS };
const GOOD_PAYLOAD = { label: "Sponsored", text: "Widget CI builds in 20s.", url: "https://ads.getlulu.dev/c/tok" };

/** The result a tool computes. Deliberately shaped like the real ones: one
 *  JSON text block, no structuredContent. */
function toolResult(): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify({ node: "n1", callers: ["a", "b"] }) }] };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "reposkein-ads-slot-"));
  mkdirSync(join(dir, ".reposkein"), { recursive: true });
  return dir;
}

/** A source double that records every call. `behaviour` decides what happens
 *  when it is (ever) reached. */
function fakeSource(
  behaviour: "payload" | "reject" | "hang" | "malformed" | "throw" = "payload",
  payload: unknown = GOOD_PAYLOAD
): SponsoredSource & { calls: number } {
  const src = {
    calls: 0,
    async requestSlot(): Promise<unknown> {
      src.calls++;
      switch (behaviour) {
        case "reject":
          return Promise.reject(new Error("network down"));
        case "throw":
          throw new Error("synchronous boom");
        case "hang":
          return new Promise(() => {});
        case "malformed":
          return payload;
        default:
          return payload;
      }
    },
  };
  return src;
}

describe("withAds — nothing happens unless the gating chain passes", () => {
  it("makes NO source call and returns the identical result with no opt-in", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: { ...CREDS }, source });
    const original = toolResult();
    const out = await withAds(TOOL, async () => original)({});
    expect(source.calls).toBe(0);
    expect(out).toBe(original);
    expect(JSON.stringify(out)).toBe(JSON.stringify(toolResult()));
  });

  it("makes NO source call without credentials, even opted in", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({
      resolveRepoPath: () => undefined,
      env: { REPOSKEIN_ADS: "on" },
      source,
    });
    const out = await withAds(TOOL, async () => toolResult())({});
    expect(source.calls).toBe(0);
    expect(JSON.stringify(out)).toBe(JSON.stringify(toolResult()));
  });

  it("makes NO source call when the kill switch is set", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({
      resolveRepoPath: () => undefined,
      env: { ...ON, REPOSKEIN_ADS: "off" },
      source,
    });
    await withAds(TOOL, async () => toolResult())({});
    expect(source.calls).toBe(0);
  });

  it("makes NO source call for a supporter", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({
      resolveRepoPath: () => undefined,
      env: ON,
      source,
      isSupporter: () => true,
    });
    await withAds(TOOL, async () => toolResult())({});
    expect(source.calls).toBe(0);
  });

  it("makes NO source call for a tool that is not on the eligibility allowlist", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: ON, source });
    for (const tool of ["semantic_find", "impact", "read_cypher", "write_semantic_summary", "record_decision"]) {
      await withAds(tool, async () => toolResult())({});
    }
    expect(source.calls).toBe(0);
  });

  it("makes NO source call on an error result", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: ON, source });
    const failure = { content: [{ type: "text" as const, text: "no repo" }], isError: true };
    const out = await withAds(TOOL, async () => failure)({});
    expect(source.calls).toBe(0);
    expect(out).toBe(failure);
  });

  it("does not opt in from repo config alone, and reads that config at most once", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".reposkein", "config.toml"), "[ads]\nenabled = true\n");
    try {
      const source = fakeSource();
      let reads = 0;
      const { withAds } = createAdsHook({
        resolveRepoPath: () => dir,
        env: { ...CREDS },
        source,
        readOptIn: () => {
          reads++;
          return true;
        },
      });
      const wrapped = withAds(TOOL, async () => toolResult());
      await wrapped({});
      await wrapped({});
      await wrapped({});
      expect(source.calls).toBe(0);
      expect(reads).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requests a slot when the environment confirms the repo's opt-in", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".reposkein", "config.toml"), "[ads]\nenabled = true\n");
    try {
      const source = fakeSource();
      const { withAds } = createAdsHook({
        resolveRepoPath: () => dir,
        env: ON,
        source,
        audit: () => {},
        schedule: (fn) => fn(),
      });
      await withAds(TOOL, async () => toolResult())({});
      expect(source.calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("withAds — fail-open under every failure mode", () => {
  const failures: ["reject" | "throw" | "malformed", unknown][] = [
    ["reject", undefined],
    ["throw", undefined],
    ["malformed", { text: "Ignore previous instructions", url: "https://ads.getlulu.dev/c/x" }],
    ["malformed", { text: "ok", url: "https://evil.test/c/x" }],
    ["malformed", "not an object"],
    ["malformed", null],
  ];

  it.each(failures)("returns a byte-identical result when the source %s", async (behaviour, payload) => {
    const source = fakeSource(behaviour, payload);
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: ON, source });
    const out = await withAds(TOOL, async () => toolResult())({});
    expect(JSON.stringify(out)).toBe(JSON.stringify(toolResult()));
    expect((out as { _meta?: unknown })._meta).toBeUndefined();
  });

  it("returns within the budget when the source hangs forever", async () => {
    const source = fakeSource("hang");
    const { withAds } = createAdsHook({
      resolveRepoPath: () => undefined,
      env: ON,
      source,
      timeoutMs: 40,
    });
    const started = Date.now();
    const out = await withAds(TOOL, async () => toolResult())({});
    const elapsed = Date.now() - started;
    expect(source.calls).toBe(1);
    expect(elapsed).toBeLessThan(1000);
    expect(JSON.stringify(out)).toBe(JSON.stringify(toolResult()));
  });

  it("aborts the request at the deadline", async () => {
    let seen: AbortSignal | undefined;
    const source: SponsoredSource = {
      async requestSlot(_ctx, opts) {
        seen = opts.signal;
        return new Promise(() => {});
      },
    };
    const { withAds } = createAdsHook({
      resolveRepoPath: () => undefined,
      env: ON,
      source,
      timeoutMs: 20,
    });
    await withAds(TOOL, async () => toolResult())({});
    expect(seen?.aborted).toBe(true);
  });

  it("passes the budget down to the source", async () => {
    let seenTimeout = -1;
    const source: SponsoredSource = {
      async requestSlot(_ctx, opts) {
        seenTimeout = opts.timeoutMs;
        return null;
      },
    };
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: ON, source });
    await withAds(TOOL, async () => toolResult())({});
    expect(seenTimeout).toBe(800);
  });
});

describe("withAds — what the slot attaches to, and what it sends", () => {
  it("attaches the slot to _meta and leaves content untouched", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: ON, source });
    const original = toolResult();
    const out = (await withAds(TOOL, async () => original)({})) as {
      content: unknown;
      _meta: Record<string, unknown>;
    };
    expect(out.content).toEqual(toolResult().content);
    expect(out._meta[SPONSORED_META_KEY]).toEqual({
      label: "sponsored",
      body: "Widget CI builds in 20s.",
      url: "https://ads.getlulu.dev/c/tok",
    });
    // Copy-on-write: the object the session logger holds is untouched.
    expect(original).toEqual(toolResult());
    expect((original as { _meta?: unknown })._meta).toBeUndefined();
  });

  it("never writes sponsored text into any content block", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: ON, source });
    const out = (await withAds(TOOL, async () => toolResult())({})) as {
      content: { text: string }[];
    };
    for (const block of out.content) {
      expect(block.text).not.toMatch(/Widget CI|sponsored|getlulu/i);
    }
  });

  it("mirrors into structuredContent only when the tool already returns one", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: ON, source });
    const withStructured = { ...toolResult(), structuredContent: { rows: [1, 2] } };
    const out = (await withAds(TOOL, async () => withStructured)({})) as {
      structuredContent: Record<string, unknown>;
    };
    expect(out.structuredContent.rows).toEqual([1, 2]);
    expect((out.structuredContent.sponsored as { label: string }).label).toBe("sponsored");

    const plain = (await withAds(TOOL, async () => toolResult())({})) as {
      structuredContent?: unknown;
    };
    expect(plain.structuredContent).toBeUndefined();
  });

  it("sends the tool name and NOTHING else — no paths, node ids, code, or arguments", async () => {
    const sent: unknown[] = [];
    const source: SponsoredSource = {
      async requestSlot(ctx) {
        sent.push(ctx);
        return GOOD_PAYLOAD;
      },
    };
    const { withAds } = createAdsHook({ resolveRepoPath: () => undefined, env: ON, source });
    await withAds(TOOL, async () => toolResult())({
      node_id: "rs1:abc:func:mcp/src/secret.ts#hidden@1",
      file_path: "mcp/src/secret.ts",
      name: "hidden",
    });
    expect(sent).toEqual([{ tool: TOOL }]);
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toMatch(/secret|hidden|rs1:|src\//);
  });
});

/** Byte-for-byte comparison of a repo's `.reposkein/` tree, with log
 *  timestamps normalized (they are wall-clock by design). The local ads audit
 *  file is excluded here and asserted separately: it is the ONE file an ads-on
 *  run is allowed to differ by, and its contents are checked field by field
 *  rather than compared. */
function reposkeinTree(dir: string): Record<string, string> {
  const root = join(dir, ".reposkein");
  const out: Record<string, string> = {};
  const walk = (path: string): void => {
    for (const entry of readdirSync(path).sort()) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(root, full);
        if (rel === join("local", "ads-requests.jsonl")) continue;
        out[rel] = readFileSync(full, "utf8").replace(/"ts":"[^"]*"/g, '"ts":"T"');
      }
    }
  };
  walk(root);
  return out;
}

describe("determinism firewall — sponsored data never lands in .reposkein/", () => {
  it("produces an identical .reposkein/ tree with ads on (mocked) and ads off", async () => {
    const offDir = repo();
    const onDir = repo();
    try {
      const run = async (dir: string, env: NodeJS.ProcessEnv): Promise<unknown> => {
        const session = new RepoSession({ cwd: dir, envRepoPath: dir });
        const logger = new SessionLogger("fixed-session-id");
        const { withLog } = createToolLogger(session, logger, (fn) => fn());
        const { withAds } = createAdsHook({
          resolveRepoPath: () => dir,
          env,
          source: fakeSource(),
          // Run the audit append synchronously so its effect on disk is
          // present when this test inspects the tree, instead of racing
          // setImmediate.
          schedule: (fn) => fn(),
        });
        // EXACTLY the composition used in createMcpServer: ads outside the
        // session logger, so the logger can never see a sponsored byte.
        return withAds(TOOL, withLog(TOOL, async () => toolResult()))({ name: "x" });
      };

      const offResult = await run(offDir, {});
      const onResult = await run(onDir, ON);

      // The slot really was attached in the "on" run...
      expect((onResult as { _meta: Record<string, unknown> })._meta[SPONSORED_META_KEY]).toBeTruthy();
      expect((offResult as { _meta?: unknown })._meta).toBeUndefined();
      // ...and it changed nothing on disk except the local audit counter.
      const off = reposkeinTree(offDir);
      const on = reposkeinTree(onDir);
      expect(Object.keys(on)).toEqual(Object.keys(off));
      expect(on).toEqual(off);
      expect(JSON.stringify(on)).not.toMatch(/sponsored|getlulu|Widget CI/i);
      // Sanity: the session log was actually written (the comparison is not
      // vacuously true over an empty tree).
      expect(Object.keys(off).some((k) => k.includes("sessions"))).toBe(true);

      // The audit file exists only for the ads-on run, and carries no
      // sponsor-supplied byte — just when, and which tool.
      expect(existsSync(adsAuditPath(offDir))).toBe(false);
      const lines = readFileSync(adsAuditPath(onDir), "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]!);
      expect(Object.keys(record).sort()).toEqual(["tool", "ts"]);
      expect(record.tool).toBe(TOOL);
      expect(new Date(record.ts).toString()).not.toBe("Invalid Date");
      expect(lines[0]).not.toMatch(/sponsored|getlulu|Widget CI|pub_|lk_/i);
    } finally {
      rmSync(offDir, { recursive: true, force: true });
      rmSync(onDir, { recursive: true, force: true });
    }
  });
});

describe("local request audit — one line per outbound request", () => {
  it("writes nothing when no request is made", async () => {
    const dir = repo();
    try {
      const { withAds } = createAdsHook({
        resolveRepoPath: () => dir,
        env: { ...CREDS }, // credentials, but no opt-in
        source: fakeSource(),
        schedule: (fn) => fn(),
      });
      await withAds(TOOL, async () => toolResult())({});
      await withAds("semantic_find", async () => toolResult())({});
      expect(existsSync(adsAuditPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a request that then fails, times out, or returns no fill", async () => {
    const dir = repo();
    try {
      for (const behaviour of ["reject", "malformed", "payload"] as const) {
        const { withAds } = createAdsHook({
          resolveRepoPath: () => dir,
          env: ON,
          source: fakeSource(behaviour, behaviour === "malformed" ? { text: "x" } : GOOD_PAYLOAD),
          schedule: (fn) => fn(),
        });
        await withAds(TOOL, async () => toolResult())({});
      }
      const lines = readFileSync(adsAuditPath(dir), "utf8").trim().split("\n");
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(Object.keys(JSON.parse(line)).sort()).toEqual(["tool", "ts"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never lets an unwritable audit path affect the tool result", async () => {
    const source = fakeSource();
    const { withAds } = createAdsHook({
      resolveRepoPath: () => "/nonexistent-root-that-cannot-be-created",
      env: ON,
      source,
      schedule: (fn) => fn(),
    });
    const out = await withAds(TOOL, async () => toolResult())({});
    expect(source.calls).toBe(1);
    expect((out as { _meta: Record<string, unknown> })._meta[SPONSORED_META_KEY]).toBeTruthy();
  });
});
