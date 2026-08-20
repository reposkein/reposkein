import { resolveRepoPath } from "../store/resolveRepoPath.js";
import { GREP_BASELINE_MULTIPLIER, listSessionFiles, readSessionLog, summarizeSession, summarizeSessions, type SessionSummary } from "../store/sessionStats.js";
import { colorEnabled, styler } from "./ansi.js";

export interface StatsSelection {
  mode: "last" | "session" | "all";
  sessionId?: string;
}

/** Parses `reposkein-mcp stats [path] [--last | --session <id> | --all] [--json]`.
 *  Exactly one of `--last` / `--session` / `--all` may be given; defaults to
 *  `--last` (the useful default for a Stop-hook running right after a
 *  session ends). */
export function parseStatsArgs(argv: string[]): {
  path?: string;
  selection: StatsSelection;
  json: boolean;
  error?: string;
} {
  let path: string | undefined;
  let json = false;
  let selection: StatsSelection | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--last") {
      if (selection) return { selection: { mode: "last" }, json, error: "pass only one of --last / --session / --all" };
      selection = { mode: "last" };
    } else if (arg === "--all") {
      if (selection) return { selection: { mode: "all" }, json, error: "pass only one of --last / --session / --all" };
      selection = { mode: "all" };
    } else if (arg === "--session") {
      if (selection) return { selection: { mode: "session" }, json, error: "pass only one of --last / --session / --all" };
      const id = argv[i + 1];
      if (!id || id.startsWith("-")) return { selection: { mode: "session" }, json, error: "--session requires a session id" };
      selection = { mode: "session", sessionId: id };
      i++;
    } else if (arg && !arg.startsWith("-")) {
      path = arg;
    }
  }
  return { path, selection: selection ?? { mode: "last" }, json };
}

/** Resolves which session(s) `selection` refers to and aggregates them.
 *  Returns null (with `error` populated) when nothing was found — a repo
 *  with no `.reposkein/local/sessions/` yet, an unknown `--session` id, etc. */
export function resolveStats(repoPath: string, selection: StatsSelection): { summary?: SessionSummary; error?: string } {
  const files = listSessionFiles(repoPath);
  if (selection.mode === "all") {
    if (files.length === 0) return { error: `no session logs found under ${repoPath}/.reposkein/local/sessions/` };
    return { summary: summarizeSessions(files) };
  }
  if (selection.mode === "session") {
    const hit = files.find((f) => f.sessionId === selection.sessionId);
    if (!hit) {
      return {
        error:
          `no session "${selection.sessionId}" found under ${repoPath}/.reposkein/local/sessions/` +
          (files.length ? ` (known: ${files.map((f) => f.sessionId).join(", ")})` : ""),
      };
    }
    return { summary: summarizeSession(hit.sessionId, hit.file, readSessionLog(hit.file)) };
  }
  // "last"
  if (files.length === 0) return { error: `no session logs found under ${repoPath}/.reposkein/local/sessions/` };
  const hit = files[0]!;
  return { summary: summarizeSession(hit.sessionId, hit.file, readSessionLog(hit.file)) };
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "< 1s";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Renders the terminal report for one summary. `color` selects styled vs.
 *  plain output — callers pass `colorEnabled()`'s result (TTY + no NO_COLOR). */
export function renderStatsReport(summary: SessionSummary, color: boolean): string {
  const c = styler(color);
  const lines: string[] = [];
  lines.push(c.bold(c.teal(`reposkein stats — session ${summary.sessionId}`)));
  lines.push("");

  lines.push(c.bold("Calls by tool"));
  const tools = Object.entries(summary.callsByTool).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (tools.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [tool, count] of tools) lines.push(`  ${String(count).padStart(4)}  ${tool}`);
  }
  lines.push("");

  lines.push(c.bold("Top queried nodes/files"));
  if (summary.topTouched.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const { id, count } of summary.topTouched) lines.push(`  ${String(count).padStart(4)}  ${id}`);
  }
  lines.push("");

  lines.push(c.bold("Written this session"));
  lines.push(`  ${summary.decisionsWritten} ADR${summary.decisionsWritten === 1 ? "" : "s"} (record_decision)`);
  lines.push(`  ${summary.summariesWritten} summar${summary.summariesWritten === 1 ? "y" : "ies"} (write_semantic_summary)`);
  lines.push("");

  lines.push(c.bold("Session"));
  lines.push(`  ${summary.recordCount} call${summary.recordCount === 1 ? "" : "s"}, duration ${formatDuration(summary.durationMs)}`);
  if (summary.failedCalls > 0) lines.push(`  ${c.amber(`${summary.failedCalls} failed call${summary.failedCalls === 1 ? "" : "s"}`)}`);
  lines.push("");

  lines.push(c.bold(c.amber("Estimated context tokens saved vs. grep")));
  lines.push(
    `  ~${summary.estimatedRepoSkeinTokens.toLocaleString()} tokens returned` +
      ` (${formatBytes(summary.totalResultBytes)}) · ` +
      `an equivalent grep-based agent would cost an ESTIMATED ~${summary.estimatedGrepTokens.toLocaleString()} tokens` +
      ` (${GREP_BASELINE_MULTIPLIER}x, mcp/bench Track 1 mean) · ` +
      `~${summary.estimatedTokensSaved.toLocaleString()} tokens saved (estimate, not measured this session)`
  );
  return lines.join("\n");
}

export function renderStatsJson(summary: SessionSummary): string {
  return JSON.stringify(
    {
      sessionId: summary.sessionId,
      recordCount: summary.recordCount,
      callsByTool: summary.callsByTool,
      topTouched: summary.topTouched,
      decisionsWritten: summary.decisionsWritten,
      summariesWritten: summary.summariesWritten,
      durationMs: summary.durationMs,
      failedCalls: summary.failedCalls,
      totalResultBytes: summary.totalResultBytes,
      grepBaselineMultiplier: GREP_BASELINE_MULTIPLIER,
      estimatedRepoSkeinTokens: summary.estimatedRepoSkeinTokens,
      estimatedGrepTokens: summary.estimatedGrepTokens,
      estimatedTokensSaved: summary.estimatedTokensSaved,
      estimate: true,
    },
    null,
    2
  );
}

/** Entry point for `reposkein-mcp stats [path] [--last | --session <id> | --all] [--json]`.
 *  Returns the process exit code. */
export function runStats(argv: string[], cwd: string, envRepoPath: string | undefined): number {
  const { path, selection, json, error: argError } = parseStatsArgs(argv);
  if (argError) {
    console.error(`reposkein stats: ${argError}`);
    return 1;
  }
  const resolution = resolveRepoPath({ cwd, envRepoPath, explicit: path });
  if (!resolution.repoPath) {
    console.error(
      resolution.candidates && resolution.candidates.length > 0
        ? `reposkein stats: multiple repos found under ${cwd}: ${resolution.candidates.join(", ")}. Pass one explicitly.`
        : `reposkein stats: no RepoSkein repo found under ${cwd}. Run \`reposkein-mcp init\`, or pass a path / set REPOSKEIN_REPO_PATH.`
    );
    return 1;
  }
  const { summary, error } = resolveStats(resolution.repoPath, selection);
  if (!summary) {
    console.error(`reposkein stats: ${error}`);
    return 1;
  }
  if (json) {
    console.log(renderStatsJson(summary));
  } else {
    console.log(renderStatsReport(summary, colorEnabled()));
  }
  return 0;
}
