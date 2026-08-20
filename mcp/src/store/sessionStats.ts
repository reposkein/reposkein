import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir, type SessionLogRecord } from "./sessionLog.js";

/** grep-baseline token-ratio multiplier used for the "estimated context
 *  tokens saved" stat. Sourced from `mcp/bench/README.md`'s Track 1 retrieval
 *  benchmark ("Mean token ratio on structural tasks: 8.4x (grep / RepoSkein,
 *  generous-to-grep)") — a measured, repo-local number, not invented here.
 *  Always LABEL output built from this as an estimate: it's one repo's
 *  5-task mean, generalized to every call in a session. */
export const GREP_BASELINE_MULTIPLIER = 8.4;

export interface SessionSummary {
  sessionId: string;
  /** Absolute path to the session's .jsonl file. */
  file: string;
  recordCount: number;
  callsByTool: Record<string, number>;
  /** Top node ids / file paths touched, most-referenced first. */
  topTouched: Array<{ id: string; count: number }>;
  /** Count of ADRs recorded this session (record_decision calls). */
  decisionsWritten: number;
  /** Count of semantic summaries written this session (write_semantic_summary calls). */
  summariesWritten: number;
  /** ms between the first and last record's `ts`. 0 for a single-record session. */
  durationMs: number;
  totalResultBytes: number;
  /** GREP_BASELINE_MULTIPLIER * totalResultBytes / 4 (≈4 bytes/token), i.e.
   *  the estimated token cost an equivalent grep-based approach would have
   *  paid for what RepoSkein returned in `totalResultBytes`. Labeled an
   *  estimate everywhere it's rendered — see GREP_BASELINE_MULTIPLIER. */
  estimatedGrepTokens: number;
  estimatedRepoSkeinTokens: number;
  estimatedTokensSaved: number;
  failedCalls: number;
}

/** Reads and parses one session's JSONL file. Malformed lines are skipped
 *  (never thrown) — a session log is best-effort telemetry, not a source of
 *  truth that must be pristine. */
export function readSessionLog(file: string): SessionLogRecord[] {
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: SessionLogRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const rec = JSON.parse(line) as Partial<SessionLogRecord>;
      if (typeof rec.tool === "string" && typeof rec.ts === "string") {
        out.push({
          ts: rec.ts,
          tool: rec.tool,
          argsShape: Array.isArray(rec.argsShape) ? rec.argsShape : [],
          resultBytes: typeof rec.resultBytes === "number" ? rec.resultBytes : 0,
          ...(Array.isArray(rec.nodeIds) && rec.nodeIds.length ? { nodeIds: rec.nodeIds } : {}),
          ok: rec.ok !== false,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Every session file for a repo, sorted newest-first (by mtime). */
export function listSessionFiles(repoPath: string): Array<{ sessionId: string; file: string; mtimeMs: number }> {
  const dir = sessionsDir(repoPath);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const file = join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        /* keep 0 — still listed, just sorts last */
      }
      return { sessionId: name.replace(/\.jsonl$/, ""), file, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Tools whose calls count as "summaries/ADRs written this session". */
const DECISION_TOOLS = new Set(["record_decision"]);
const SUMMARY_TOOLS = new Set(["write_semantic_summary"]);

/** Aggregates one session's records into the report shape rendered by
 *  `reposkein-mcp stats`. Pure function over already-parsed records so it's
 *  cheap to unit test independent of the filesystem. */
export function summarizeSession(sessionId: string, file: string, records: SessionLogRecord[]): SessionSummary {
  const callsByTool: Record<string, number> = {};
  const touchedCounts = new Map<string, number>();
  let decisionsWritten = 0;
  let summariesWritten = 0;
  let totalResultBytes = 0;
  let failedCalls = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const rec of records) {
    callsByTool[rec.tool] = (callsByTool[rec.tool] ?? 0) + 1;
    totalResultBytes += rec.resultBytes;
    if (!rec.ok) failedCalls++;
    if (DECISION_TOOLS.has(rec.tool)) decisionsWritten++;
    if (SUMMARY_TOOLS.has(rec.tool)) summariesWritten++;
    for (const id of rec.nodeIds ?? []) touchedCounts.set(id, (touchedCounts.get(id) ?? 0) + 1);
    const t = Date.parse(rec.ts);
    if (!Number.isNaN(t)) {
      if (t < minTs) minTs = t;
      if (t > maxTs) maxTs = t;
    }
  }

  const topTouched = [...touchedCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([id, count]) => ({ id, count }));

  const durationMs = Number.isFinite(minTs) && Number.isFinite(maxTs) && maxTs > minTs ? maxTs - minTs : 0;

  // ~4 bytes/token is the common rough estimator (also used by mcp/bench —
  // see its token cost model) — deliberately simple and labeled an estimate.
  const estimatedRepoSkeinTokens = Math.round(totalResultBytes / 4);
  const estimatedGrepTokens = Math.round(estimatedRepoSkeinTokens * GREP_BASELINE_MULTIPLIER);
  const estimatedTokensSaved = estimatedGrepTokens - estimatedRepoSkeinTokens;

  return {
    sessionId,
    file,
    recordCount: records.length,
    callsByTool,
    topTouched,
    decisionsWritten,
    summariesWritten,
    durationMs,
    totalResultBytes,
    estimatedGrepTokens,
    estimatedRepoSkeinTokens,
    estimatedTokensSaved,
    failedCalls,
  };
}

/** Merges several sessions' records into one combined summary (`--all`) —
 *  same aggregation, over the union of records, with a synthetic id. */
export function summarizeSessions(sessions: Array<{ sessionId: string; file: string }>): SessionSummary {
  const allRecords = sessions.flatMap((s) => readSessionLog(s.file));
  const label = sessions.length === 1 ? sessions[0]!.sessionId : `${sessions.length} sessions`;
  return summarizeSession(label, sessions.map((s) => s.file).join(","), allRecords);
}
