import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** One JSONL record per tool invocation, appended to the active repo's
 *  `.reposkein/local/sessions/<session-id>.jsonl` (REP-20). Never contains
 *  argument or result VALUES — only shapes/sizes — so it's safe to leave
 *  lying around on disk (though it's git-ignored regardless, see
 *  `.reposkein/.gitignore` written by the indexer: `local/`). */
export interface SessionLogRecord {
  /** ISO-8601 timestamp of the call. */
  ts: string;
  /** MCP tool name, e.g. "get_context_profile". */
  tool: string;
  /** Argument KEY NAMES only, sorted — never values (may contain code/user text). */
  argsShape: string[];
  /** Byte size of the text content returned to the agent. */
  resultBytes: number;
  /** Node ids / file paths the call touched, when the result exposes them
   *  (best-effort — see `extractTouchedIds`). Omitted when none found. */
  nodeIds?: string[];
  /** False when the handler threw or returned `isError: true`. */
  ok: boolean;
}

export interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** `<repoPath>/.reposkein/local/sessions` — where per-session JSONL logs
 *  live for this repo. Git-ignored via `.reposkein/.gitignore`'s `local/`
 *  entry (written by the indexer at index time). */
export function sessionsDir(repoPath: string): string {
  return join(repoPath, ".reposkein", "local", "sessions");
}

export function sessionLogPath(repoPath: string, sessionId: string): string {
  return join(sessionsDir(repoPath), `${sessionId}.jsonl`);
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

/** Session id = server process lifetime: start-timestamp + pid. Filesystem-
 *  safe (no colons) and lexicographically sortable = chronological. */
export function defaultSessionId(now: Date = new Date(), pid: number = process.pid): string {
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `${stamp}-${pid}`;
}

/** Resolves this process's session id: `REPOSKEIN_SESSION_ID` override, else
 *  `defaultSessionId()`. Computed once per server process and reused for
 *  every call and every repo it touches during the connection's lifetime. */
export function resolveSessionId(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  pid: number = process.pid
): string {
  const override = env.REPOSKEIN_SESSION_ID?.trim();
  return override ? override : defaultSessionId(now, pid);
}

/** Appends one record. Best-effort: a write failure (unwritable dir, full
 *  disk, permission error) is swallowed — logging must never fail or slow a
 *  tool call. Creates `local/sessions/` if needed. */
export function appendSessionLog(repoPath: string, sessionId: string, record: SessionLogRecord): void {
  try {
    mkdirSync(sessionsDir(repoPath), { recursive: true });
    appendFileSync(sessionLogPath(repoPath, sessionId), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // best-effort — see doc comment
  }
}

export interface PruneOptions {
  /** Keep at most this many session files (newest first, by mtime). */
  keep: number;
  /** Drop any session file older than this many days, even if under `keep`. */
  maxAgeDays: number;
}

export const DEFAULT_RETENTION: PruneOptions = { keep: 50, maxAgeDays: 30 };

/** Prunes `local/sessions/` for one repo: a file survives only if it is both
 *  among the `keep` most-recently-modified files AND newer than
 *  `maxAgeDays`. Deleting one file's read/stat failure never aborts the
 *  sweep. Silently no-ops if the dir doesn't exist or isn't readable —
 *  pruning must never fail server startup. */
export function pruneSessions(
  repoPath: string,
  opts: PruneOptions = DEFAULT_RETENTION,
  now: number = Date.now()
): void {
  try {
    const dir = sessionsDir(repoPath);
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const withStats = files
      .map((f) => {
        const path = join(dir, f);
        try {
          return { path, mtimeMs: statSync(path).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { path: string; mtimeMs: number } => x !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    const maxAgeMs = opts.maxAgeDays * 24 * 60 * 60 * 1000;
    withStats.forEach((entry, idx) => {
      const tooOld = now - entry.mtimeMs > maxAgeMs;
      const overCount = idx >= opts.keep;
      if (tooOld || overCount) {
        try {
          unlinkSync(entry.path);
        } catch {
          // best-effort
        }
      }
    });
  } catch {
    // best-effort — see doc comment
  }
}

/** Keys whose STRING value is treated as an id/path a tool call touched. */
const ID_KEYS = new Set(["node_id", "id", "decision_id"]);
/** Keys whose ARRAY value holds ids/paths (each string element collected). */
const ID_ARRAY_KEYS = new Set(["node_ids", "anchor_node_ids"]);
/** Keys whose STRING value is a file path a tool call touched. */
const PATH_KEYS = new Set(["file_path", "path"]);

const MAX_TOUCHED_IDS = 25;
const MAX_WALK_DEPTH = 6;

function walkForIds(value: unknown, out: Set<string>, depth: number): void {
  if (out.size >= MAX_TOUCHED_IDS || depth > MAX_WALK_DEPTH || value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) walkForIds(v, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (out.size >= MAX_TOUCHED_IDS) return;
    if ((ID_KEYS.has(key) || PATH_KEYS.has(key)) && typeof v === "string") {
      out.add(v);
    } else if (ID_ARRAY_KEYS.has(key) && Array.isArray(v)) {
      for (const item of v) {
        if (out.size >= MAX_TOUCHED_IDS) break;
        if (typeof item === "string") out.add(item);
      }
    } else {
      walkForIds(v, out, depth + 1);
    }
  }
}

/** Best-effort extraction of node ids / file paths a tool call touched, from
 *  its JSON-text result content — used for the "top queried nodes/files"
 *  stat. Generic (one implementation for all tools, not per-tool logic):
 *  parses each text block as JSON and walks it for a small allowlist of
 *  id-shaped keys (`node_id`, `id`, `decision_id`, `node_ids`,
 *  `anchor_node_ids`, `file_path`, `path`). Non-JSON or unparseable content
 *  contributes nothing — never throws. */
export function extractTouchedIds(result: ToolResultLike | undefined): string[] {
  if (!result) return [];
  const found = new Set<string>();
  for (const block of result.content ?? []) {
    if (found.size >= MAX_TOUCHED_IDS) break;
    if (block.type !== "text" || typeof block.text !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      continue;
    }
    walkForIds(parsed, found, 0);
  }
  return [...found];
}

/** Byte size of the text an agent would actually read from a tool result
 *  (sum of `content[].text`), the basis for "context tokens saved". Falls
 *  back to the full JSON envelope size only when there's no text content AT
 *  ALL (no `content` array, or no block of type "text") — a result whose
 *  text blocks exist but are empty strings correctly reports 0, it does not
 *  fall back to stringifying the envelope. */
export function resultByteSize(result: ToolResultLike | undefined): number {
  if (!result) return 0;
  const blocks = result.content ?? [];
  let bytes = 0;
  let hasTextBlock = false;
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      hasTextBlock = true;
      bytes += Buffer.byteLength(block.text, "utf8");
    }
  }
  return hasTextBlock ? bytes : Buffer.byteLength(JSON.stringify(result), "utf8");
}

/** Argument KEY NAMES only, sorted, never values. */
export function argsShapeOf(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  return Object.keys(args as Record<string, unknown>).sort();
}

/** The single per-process instrumentation sink: one instance is created in
 *  `main()` and shared by the tool-dispatch wrapper for every registered
 *  tool (see `createToolLogger`/`withLog` in instrumentTool.ts) — the one
 *  place tool calls get logged, so individual tool handlers never contain
 *  logging code.
 *
 *  Retention is enforced lazily, per repo, the first time this process logs
 *  a call for that repo — equivalent to "prune on server start" for the
 *  common single-repo case, and the only sound definition of "start" once a
 *  session can touch more than one repo (zero-config workspace mode). */
export class SessionLogger {
  private readonly sessionId: string;
  private readonly retention: PruneOptions;
  private readonly prunedRepos = new Set<string>();

  constructor(sessionId: string, retention: PruneOptions = DEFAULT_RETENTION) {
    this.sessionId = sessionId;
    this.retention = retention;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  log(repoPath: string, entry: Omit<SessionLogRecord, "ts">): void {
    this.logAt(new Date().toISOString(), repoPath, entry);
  }

  /** Same as `log`, but with `ts` supplied by the caller instead of stamped
   *  here — for the deferred-write path (see `instrumentTool.ts`), where the
   *  call's completion time is captured synchronously on the hot path and
   *  the actual write happens later (setImmediate); using that captured
   *  `ts` keeps the record's timestamp accurate to when the call finished,
   *  not to whenever the deferred write got scheduled. */
  logAt(ts: string, repoPath: string, entry: Omit<SessionLogRecord, "ts">): void {
    try {
      if (!this.prunedRepos.has(repoPath)) {
        this.prunedRepos.add(repoPath);
        pruneSessions(repoPath, this.retention);
      }
      appendSessionLog(repoPath, this.sessionId, { ts, ...entry });
    } catch {
      // never fail/slow the tool call — see appendSessionLog's own try/catch too
    }
  }
}
