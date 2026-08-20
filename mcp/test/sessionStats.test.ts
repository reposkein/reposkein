import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionsDir, type SessionLogRecord } from "../src/store/sessionLog.js";
import {
  GREP_BASELINE_MULTIPLIER,
  listSessionFiles,
  readSessionLog,
  summarizeSession,
  summarizeSessions,
} from "../src/store/sessionStats.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-sessionstats-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readSessionLog", () => {
  it("parses well-formed JSONL records", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ ts: "2026-08-20T10:00:00Z", tool: "impact", argsShape: ["node_id"], resultBytes: 100, ok: true }),
        JSON.stringify({ ts: "2026-08-20T10:00:01Z", tool: "semantic_find", argsShape: ["query"], resultBytes: 50, ok: false }),
      ].join("\n") + "\n"
    );
    const recs = readSessionLog(file);
    expect(recs).toHaveLength(2);
    expect(recs[0]!.tool).toBe("impact");
    expect(recs[1]!.ok).toBe(false);
  });

  it("skips malformed lines instead of throwing", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `not json\n${JSON.stringify({ ts: "2026-08-20T10:00:00Z", tool: "impact" })}\n\n`);
    const recs = readSessionLog(file);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.tool).toBe("impact");
  });

  it("returns [] for a missing file", () => {
    expect(readSessionLog(join(dir, "nope.jsonl"))).toEqual([]);
  });
});

describe("listSessionFiles", () => {
  it("lists .jsonl files newest-first by mtime", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });
    const older = join(sessionsDir(dir), "old.jsonl");
    const newer = join(sessionsDir(dir), "new.jsonl");
    writeFileSync(older, "{}\n");
    writeFileSync(newer, "{}\n");
    const now = Date.now();
    utimesSync(older, new Date(now - 10_000), new Date(now - 10_000));
    utimesSync(newer, new Date(now), new Date(now));
    const files = listSessionFiles(dir);
    expect(files.map((f) => f.sessionId)).toEqual(["new", "old"]);
  });

  it("returns [] when there is no sessions dir", () => {
    expect(listSessionFiles(dir)).toEqual([]);
  });
});

function rec(overrides: Partial<SessionLogRecord> = {}): SessionLogRecord {
  return { ts: "2026-08-20T10:00:00Z", tool: "impact", argsShape: [], resultBytes: 0, ok: true, ...overrides };
}

describe("summarizeSession — aggregation math", () => {
  it("counts calls by tool", () => {
    const records = [rec({ tool: "impact" }), rec({ tool: "impact" }), rec({ tool: "semantic_find" })];
    const s = summarizeSession("sess-1", "file", records);
    expect(s.callsByTool).toEqual({ impact: 2, semantic_find: 1 });
    expect(s.recordCount).toBe(3);
  });

  it("ranks top touched node ids/files by frequency, then alphabetically on ties", () => {
    const records = [
      rec({ nodeIds: ["a", "b"] }),
      rec({ nodeIds: ["b"] }),
      rec({ nodeIds: ["c"] }),
    ];
    const s = summarizeSession("sess-1", "file", records);
    expect(s.topTouched[0]).toEqual({ id: "b", count: 2 });
    expect(s.topTouched.slice(1)).toEqual(
      expect.arrayContaining([
        { id: "a", count: 1 },
        { id: "c", count: 1 },
      ])
    );
  });

  it("counts record_decision as an ADR written and write_semantic_summary as a summary written", () => {
    const records = [
      rec({ tool: "record_decision" }),
      rec({ tool: "record_decision" }),
      rec({ tool: "write_semantic_summary" }),
      rec({ tool: "get_context_profile" }),
    ];
    const s = summarizeSession("sess-1", "file", records);
    expect(s.decisionsWritten).toBe(2);
    expect(s.summariesWritten).toBe(1);
  });

  it("computes duration as the span between the first and last record ts", () => {
    const records = [
      rec({ ts: "2026-08-20T10:00:00.000Z" }),
      rec({ ts: "2026-08-20T10:05:30.000Z" }),
      rec({ ts: "2026-08-20T10:02:00.000Z" }),
    ];
    const s = summarizeSession("sess-1", "file", records);
    expect(s.durationMs).toBe(5.5 * 60 * 1000);
  });

  it("duration is 0 for a single-record session", () => {
    const s = summarizeSession("sess-1", "file", [rec()]);
    expect(s.durationMs).toBe(0);
  });

  it("counts failed calls (ok: false)", () => {
    const s = summarizeSession("sess-1", "file", [rec({ ok: true }), rec({ ok: false }), rec({ ok: false })]);
    expect(s.failedCalls).toBe(2);
  });

  it("estimates grep-baseline tokens using GREP_BASELINE_MULTIPLIER over ~4 bytes/token", () => {
    const s = summarizeSession("sess-1", "file", [rec({ resultBytes: 400 }), rec({ resultBytes: 400 })]);
    expect(s.totalResultBytes).toBe(800);
    expect(s.estimatedRepoSkeinTokens).toBe(200); // 800 / 4
    expect(s.estimatedGrepTokens).toBe(Math.round(200 * GREP_BASELINE_MULTIPLIER));
    expect(s.estimatedTokensSaved).toBe(s.estimatedGrepTokens - s.estimatedRepoSkeinTokens);
    expect(GREP_BASELINE_MULTIPLIER).toBe(8.4); // mcp/bench/README.md Track 1 mean
  });

  it("handles an empty session", () => {
    const s = summarizeSession("sess-1", "file", []);
    expect(s.recordCount).toBe(0);
    expect(s.callsByTool).toEqual({});
    expect(s.topTouched).toEqual([]);
    expect(s.durationMs).toBe(0);
    expect(s.estimatedTokensSaved).toBe(0);
  });
});

describe("summarizeSessions — --all across multiple session files", () => {
  it("merges records from every session into one summary", () => {
    const f1 = join(dir, "a.jsonl");
    const f2 = join(dir, "b.jsonl");
    writeFileSync(f1, JSON.stringify(rec({ tool: "impact" })) + "\n");
    writeFileSync(f2, JSON.stringify(rec({ tool: "semantic_find" })) + "\n");
    const s = summarizeSessions([
      { sessionId: "a", file: f1 },
      { sessionId: "b", file: f2 },
    ]);
    expect(s.recordCount).toBe(2);
    expect(s.callsByTool).toEqual({ impact: 1, semantic_find: 1 });
    expect(s.sessionId).toBe("2 sessions");
  });
});
