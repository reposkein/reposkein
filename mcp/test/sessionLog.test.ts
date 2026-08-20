import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_RETENTION,
  SessionLogger,
  appendSessionLog,
  argsShapeOf,
  defaultSessionId,
  extractTouchedIds,
  pruneSessions,
  resolveSessionId,
  resultByteSize,
  sessionLogPath,
  sessionsDir,
  type SessionLogRecord,
} from "../src/store/sessionLog.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-sessionlog-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rec(overrides: Partial<SessionLogRecord> = {}): SessionLogRecord {
  return {
    ts: new Date().toISOString(),
    tool: "get_context_profile",
    argsShape: ["name"],
    resultBytes: 10,
    ok: true,
    ...overrides,
  };
}

describe("defaultSessionId / resolveSessionId", () => {
  it("is start-timestamp + pid, filesystem-safe (no colons)", () => {
    const id = defaultSessionId(new Date("2026-08-20T21:56:07Z"), 4242);
    expect(id).toBe("20260820T215607Z-4242");
    expect(id).not.toMatch(/:/);
  });

  it("REPOSKEIN_SESSION_ID overrides the default", () => {
    const id = resolveSessionId({ REPOSKEIN_SESSION_ID: "custom-session-1" } as NodeJS.ProcessEnv);
    expect(id).toBe("custom-session-1");
  });

  it("falls back to defaultSessionId when unset or blank", () => {
    expect(resolveSessionId({} as NodeJS.ProcessEnv, new Date("2026-01-01T00:00:00Z"), 1)).toBe("20260101T000000Z-1");
    expect(resolveSessionId({ REPOSKEIN_SESSION_ID: "  " } as NodeJS.ProcessEnv, new Date("2026-01-01T00:00:00Z"), 1)).toBe(
      "20260101T000000Z-1"
    );
  });
});

describe("appendSessionLog", () => {
  it("creates local/sessions/ and appends a JSONL record", () => {
    appendSessionLog(dir, "sess-1", rec({ tool: "impact" }));
    const path = sessionLogPath(dir, "sess-1");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).tool).toBe("impact");
  });

  it("appends multiple records across calls", () => {
    appendSessionLog(dir, "sess-1", rec({ tool: "impact" }));
    appendSessionLog(dir, "sess-1", rec({ tool: "semantic_find" }));
    const lines = readFileSync(sessionLogPath(dir, "sess-1"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("never throws when the target directory is unwritable (failure tolerance)", () => {
    const readonlyRoot = join(dir, "readonly");
    mkdirSync(readonlyRoot);
    chmodSync(readonlyRoot, 0o444);
    try {
      expect(() => appendSessionLog(readonlyRoot, "sess-1", rec())).not.toThrow();
      // best-effort: the write silently failed, nothing was created
      expect(existsSync(sessionLogPath(readonlyRoot, "sess-1"))).toBe(false);
    } finally {
      chmodSync(readonlyRoot, 0o755); // restore so rmSync in afterEach can clean up
    }
  });

  it("never throws when repoPath itself doesn't exist", () => {
    expect(() => appendSessionLog(join(dir, "does", "not", "exist"), "sess-1", rec())).not.toThrow();
  });
});

describe("pruneSessions", () => {
  function writeSessionFile(name: string, ageMs: number): void {
    const file = join(sessionsDir(dir), `${name}.jsonl`);
    mkdirSync(sessionsDir(dir), { recursive: true });
    writeFileSync(file, "{}\n");
    const mtime = new Date(Date.now() - ageMs);
    utimesSync(file, mtime, mtime);
  }

  it("keeps at most `keep` newest files", () => {
    for (let i = 0; i < 60; i++) writeSessionFile(`s${String(i).padStart(2, "0")}`, i * 1000);
    pruneSessions(dir, { keep: 50, maxAgeDays: 3650 });
    const files = readdirSync(sessionsDir(dir));
    expect(files).toHaveLength(50);
    // the 50 newest (smallest age index) survive: s00..s49
    expect(files).toContain("s00.jsonl");
    expect(files).not.toContain("s59.jsonl");
  });

  it("drops files older than maxAgeDays even when under the keep limit", () => {
    const day = 24 * 60 * 60 * 1000;
    writeSessionFile("fresh", 1 * day);
    writeSessionFile("stale", 40 * day);
    pruneSessions(dir, { keep: 50, maxAgeDays: 30 });
    const files = readdirSync(sessionsDir(dir));
    expect(files).toContain("fresh.jsonl");
    expect(files).not.toContain("stale.jsonl");
  });

  it("uses DEFAULT_RETENTION (50 / 30 days) when no options given", () => {
    expect(DEFAULT_RETENTION).toEqual({ keep: 50, maxAgeDays: 30 });
  });

  it("no-ops (never throws) when the sessions dir doesn't exist", () => {
    expect(() => pruneSessions(join(dir, "nope"))).not.toThrow();
  });
});

describe("SessionLogger", () => {
  it("prunes a repo's sessions dir once, on first log() call for that repo", () => {
    const day = 24 * 60 * 60 * 1000;
    const file = join(sessionsDir(dir), "old.jsonl");
    mkdirSync(sessionsDir(dir), { recursive: true });
    writeFileSync(file, "{}\n");
    const old = new Date(Date.now() - 40 * day);
    utimesSync(file, old, old);

    const logger = new SessionLogger("sess-1", { keep: 50, maxAgeDays: 30 });
    logger.log(dir, { tool: "impact", argsShape: [], resultBytes: 5, ok: true });

    expect(existsSync(file)).toBe(false); // pruned before the new record was written
    const lines = readFileSync(sessionLogPath(dir, "sess-1"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("logs successive calls under the same session id", () => {
    const logger = new SessionLogger("sess-x");
    logger.log(dir, { tool: "a", argsShape: [], resultBytes: 1, ok: true });
    logger.log(dir, { tool: "b", argsShape: [], resultBytes: 2, ok: false });
    const lines = readFileSync(sessionLogPath(dir, "sess-x"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).tool)).toEqual(["a", "b"]);
    expect(logger.getSessionId()).toBe("sess-x");
  });

  it("logAt() stamps the caller-supplied ts instead of computing one — the deferred-write path", () => {
    const logger = new SessionLogger("sess-1");
    logger.logAt("2020-01-01T00:00:00.000Z", dir, { tool: "impact", argsShape: [], resultBytes: 1, ok: true });
    const rec = JSON.parse(readFileSync(sessionLogPath(dir, "sess-1"), "utf8").trim());
    expect(rec.ts).toBe("2020-01-01T00:00:00.000Z");
  });

  it("log() never throws even if the underlying write fails", () => {
    const readonlyRoot = join(dir, "readonly");
    mkdirSync(readonlyRoot);
    chmodSync(readonlyRoot, 0o444);
    const logger = new SessionLogger("sess-1");
    try {
      expect(() => logger.log(readonlyRoot, { tool: "x", argsShape: [], resultBytes: 0, ok: true })).not.toThrow();
    } finally {
      chmodSync(readonlyRoot, 0o755);
    }
  });
});

describe("argsShapeOf", () => {
  it("returns sorted key names only, never values", () => {
    expect(argsShapeOf({ zeta: "secret code", alpha: 1 })).toEqual(["alpha", "zeta"]);
  });
  it("handles non-object args", () => {
    expect(argsShapeOf(undefined)).toEqual([]);
    expect(argsShapeOf(null)).toEqual([]);
    expect(argsShapeOf("x")).toEqual([]);
  });
});

describe("resultByteSize", () => {
  it("sums the byte length of text content blocks", () => {
    const bytes = resultByteSize({ content: [{ type: "text", text: "hello" }, { type: "text", text: "world!" }] });
    expect(bytes).toBe(Buffer.byteLength("hello", "utf8") + Buffer.byteLength("world!", "utf8"));
  });
  it("falls back to the full envelope size when there's no text content", () => {
    const result = { content: [], isError: false };
    expect(resultByteSize(result)).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
  });
  it("returns 0 (not the envelope fallback) when text blocks exist but are all empty strings", () => {
    const result = { content: [{ type: "text", text: "" }, { type: "text", text: "" }], isError: false };
    expect(resultByteSize(result)).toBe(0);
  });
  it("ignores non-text blocks when computing the fallback trigger (no text block at all -> fallback)", () => {
    const result = { content: [{ type: "image" as const }] };
    expect(resultByteSize(result)).toBe(Buffer.byteLength(JSON.stringify(result), "utf8"));
  });
  it("returns 0 for undefined", () => {
    expect(resultByteSize(undefined)).toBe(0);
  });
});

describe("extractTouchedIds", () => {
  it("collects node_id from a JSON text block", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ node_id: "n1" }) }] };
    expect(extractTouchedIds(result)).toEqual(["n1"]);
  });

  it("collects node_ids / anchor_node_ids arrays and file_path/path strings", () => {
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            node_ids: ["n1", "n2"],
            anchor_node_ids: ["n3"],
            file_path: "src/a.ts",
            nested: { path: "src/b.ts" },
          }),
        },
      ],
    };
    const ids = extractTouchedIds(result);
    expect(ids).toEqual(expect.arrayContaining(["n1", "n2", "n3", "src/a.ts", "src/b.ts"]));
  });

  it("returns [] for non-JSON text content, without throwing", () => {
    const result = { content: [{ type: "text", text: "plain error message, not json" }] };
    expect(() => extractTouchedIds(result)).not.toThrow();
    expect(extractTouchedIds(result)).toEqual([]);
  });

  it("returns [] for undefined", () => {
    expect(extractTouchedIds(undefined)).toEqual([]);
  });

  it("caps collected ids at 25", () => {
    const many = Array.from({ length: 100 }, (_, i) => `n${i}`);
    const result = { content: [{ type: "text", text: JSON.stringify({ node_ids: many }) }] };
    expect(extractTouchedIds(result).length).toBeLessThanOrEqual(25);
  });
});
