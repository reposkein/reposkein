import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionsDir } from "../src/store/sessionLog.js";
import { summarizeSession } from "../src/store/sessionStats.js";
import { parseStatsArgs, renderStatsJson, renderStatsReport, resolveStats, runStats } from "../src/cli/stats.js";

describe("parseStatsArgs", () => {
  it("defaults to --last with no flags", () => {
    expect(parseStatsArgs([]).selection).toEqual({ mode: "last" });
  });
  it("parses --all", () => {
    expect(parseStatsArgs(["--all"]).selection).toEqual({ mode: "all" });
  });
  it("parses --session <id>", () => {
    expect(parseStatsArgs(["--session", "sess-1"]).selection).toEqual({ mode: "session", sessionId: "sess-1" });
  });
  it("parses --json alongside a selection flag", () => {
    const parsed = parseStatsArgs(["--all", "--json"]);
    expect(parsed.selection).toEqual({ mode: "all" });
    expect(parsed.json).toBe(true);
  });
  it("parses a leading path positional", () => {
    const parsed = parseStatsArgs(["/some/repo", "--last"]);
    expect(parsed.path).toBe("/some/repo");
  });
  it("errors when --session is missing its id", () => {
    expect(parseStatsArgs(["--session"]).error).toMatch(/requires a session id/);
  });
  it("errors when more than one selection flag is given", () => {
    expect(parseStatsArgs(["--last", "--all"]).error).toMatch(/only one/);
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-statscli-"));
  mkdirSync(join(dir, ".reposkein"), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSession(sessionId: string, records: object[]): void {
  mkdirSync(sessionsDir(dir), { recursive: true });
  writeFileSync(join(sessionsDir(dir), `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("resolveStats", () => {
  it("errors when there are no session logs yet", () => {
    const { summary, error } = resolveStats(dir, { mode: "last" });
    expect(summary).toBeUndefined();
    expect(error).toMatch(/no session logs found/);
  });

  it("--last picks the most recently modified session", () => {
    writeSession("sess-a", [{ ts: "2026-08-20T10:00:00Z", tool: "impact", argsShape: [], resultBytes: 10, ok: true }]);
    const { summary } = resolveStats(dir, { mode: "last" });
    expect(summary?.sessionId).toBe("sess-a");
  });

  it("--session <id> picks that specific session, erroring on an unknown id", () => {
    writeSession("sess-a", [{ ts: "2026-08-20T10:00:00Z", tool: "impact", argsShape: [], resultBytes: 10, ok: true }]);
    expect(resolveStats(dir, { mode: "session", sessionId: "sess-a" }).summary?.sessionId).toBe("sess-a");
    expect(resolveStats(dir, { mode: "session", sessionId: "nope" }).error).toMatch(/no session "nope"/);
  });

  it("--all merges every session", () => {
    writeSession("sess-a", [{ ts: "2026-08-20T10:00:00Z", tool: "impact", argsShape: [], resultBytes: 10, ok: true }]);
    writeSession("sess-b", [{ ts: "2026-08-20T11:00:00Z", tool: "semantic_find", argsShape: [], resultBytes: 20, ok: true }]);
    const { summary } = resolveStats(dir, { mode: "all" });
    expect(summary?.recordCount).toBe(2);
  });
});

describe("renderStatsJson", () => {
  it("produces a machine-readable shape with the labeled estimate fields", () => {
    const summary = summarizeSession("sess-1", "f", [
      { ts: "2026-08-20T10:00:00Z", tool: "impact", argsShape: ["node_id"], resultBytes: 400, nodeIds: ["n1"], ok: true },
    ]);
    const parsed = JSON.parse(renderStatsJson(summary));
    expect(parsed).toMatchObject({
      sessionId: "sess-1",
      recordCount: 1,
      callsByTool: { impact: 1 },
      topTouched: [{ id: "n1", count: 1 }],
      decisionsWritten: 0,
      summariesWritten: 0,
      failedCalls: 0,
      totalResultBytes: 400,
      grepBaselineMultiplier: 8.4,
      estimate: true,
    });
    expect(typeof parsed.estimatedTokensSaved).toBe("number");
  });
});

describe("renderStatsReport", () => {
  it("includes calls-by-tool, top touched, written-this-session, duration, and a labeled token estimate", () => {
    const summary = summarizeSession("sess-1", "f", [
      { ts: "2026-08-20T10:00:00Z", tool: "record_decision", argsShape: [], resultBytes: 100, ok: true },
      { ts: "2026-08-20T10:00:01Z", tool: "write_semantic_summary", argsShape: [], resultBytes: 50, nodeIds: ["n1"], ok: true },
    ]);
    const text = renderStatsReport(summary, false);
    expect(text).toContain("Calls by tool");
    expect(text).toContain("record_decision");
    expect(text).toContain("Top queried nodes/files");
    expect(text).toContain("n1");
    expect(text).toContain("1 ADR");
    expect(text).toContain("1 summary");
    expect(text).toContain("Session");
    expect(text).toMatch(/ESTIMATED/);
    expect(text).toContain("8.4x");
  });

  it("emits raw ANSI escapes only when color is enabled", () => {
    const summary = summarizeSession("sess-1", "f", []);
    expect(renderStatsReport(summary, false)).not.toMatch(/\x1b\[/);
    expect(renderStatsReport(summary, true)).toMatch(/\x1b\[/);
  });
});

describe("runStats (end-to-end CLI)", () => {
  it("exits 1 with an actionable message when no repo is found", () => {
    const empty = mkdtempSync(join(tmpdir(), "reposkein-norepo-"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = runStats([], empty, undefined);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/no RepoSkein repo found/i));
    } finally {
      errSpy.mockRestore();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("prints the JSON report and exits 0 for a resolvable repo with session logs", () => {
    writeSession("sess-a", [{ ts: "2026-08-20T10:00:00Z", tool: "impact", argsShape: [], resultBytes: 40, ok: true }]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = runStats([dir, "--last", "--json"], dir, undefined);
      expect(code).toBe(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(printed.sessionId).toBe("sess-a");
      expect(printed.callsByTool).toEqual({ impact: 1 });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("propagates a parse error (e.g. --session with no id) as exit 1", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = runStats([dir, "--session"], dir, undefined);
      expect(code).toBe(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/requires a session id/));
    } finally {
      errSpy.mockRestore();
    }
  });
});
