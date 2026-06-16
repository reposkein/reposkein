/**
 * Temporal context runner + sidecar cache.
 *
 * Shells out to `git log` via execFile, caches computed TemporalStats to
 * .reposkein/local/temporal/<head-sha>.json (gitignored). Second call with the
 * same HEAD sha is a cache hit (file read only).
 *
 * Graceful: not-a-git-repo / git-missing / empty history →
 *   { unavailable: "<reason>" }  (never throws into the request).
 *
 * Prunes old cache files (keeps newest K=3) on each successful compute.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseGitLog, computeTemporal, type TemporalStats } from "./gitlog.js";

const execFile = promisify(execFileCb);

export type TemporalResult = TemporalStats | { unavailable: string };

/** Max cache files to keep per repo (prune oldest when exceeded). */
const MAX_CACHE_FILES = 3;

/**
 * Cache version tag.  Bump whenever the algorithm or output shape changes so
 * stale cache files produced by an old version are automatically invalidated.
 * Format: "v<N>" — stored in the cached payload under the key `_cache_version`.
 */
const CACHE_VERSION = "v1";

/** Window defaults (also used for cache key). */
const WINDOW_MONTHS = 12;
const MAX_COMMITS = 1000;
const COMMIT_SIZE_CAP = 50;
const MIN_SUPPORT = 3;

// ── git helpers ──────────────────────────────────────────────────────────────

/** Error thrown by Node when the child output exceeds maxBuffer. */
const MAX_BUFFER_EXCEEDED = "ERR_CHILD_PROCESS_STDIO_MAX_BUFFER_SIZE";

async function gitExec(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; ok: boolean; error?: string; maxBufferExceeded?: boolean }> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20000,
      killSignal: "SIGKILL",
    });
    return { stdout, ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string; code?: string };
    if (e.code === "ENOENT") {
      return { stdout: "", ok: false, error: "git executable not found in PATH" };
    }
    if (e.code === MAX_BUFFER_EXCEEDED) {
      return { stdout: "", ok: false, maxBufferExceeded: true, error: "maxBuffer exceeded" };
    }
    // git exits non-zero for "not a git repo" etc.
    const msg = (e.stderr as string | undefined) ?? e.message ?? String(err);
    return { stdout: (e.stdout as string | undefined) ?? "", ok: false, error: msg.trim() };
  }
}

async function getHeadSha(repoPath: string): Promise<{ sha: string } | { unavailable: string }> {
  const r = await gitExec(["rev-parse", "HEAD"], repoPath);
  if (!r.ok) {
    // Check if it's a "not a git repo" error
    if (r.error?.includes("not a git repository")) {
      return { unavailable: "not a git repository" };
    }
    if (r.error?.includes("git executable not found")) {
      return { unavailable: r.error };
    }
    // Could be an empty repo (no commits yet)
    const check = await gitExec(["rev-parse", "--git-dir"], repoPath);
    if (!check.ok) return { unavailable: "not a git repository" };
    return { unavailable: "repository has no commits" };
  }
  return { sha: r.stdout.trim() };
}

async function isShallow(repoPath: string): Promise<boolean> {
  const r = await gitExec(["rev-parse", "--is-shallow-repository"], repoPath);
  return r.ok && r.stdout.trim() === "true";
}

// ── cache helpers ─────────────────────────────────────────────────────────────

function cacheDir(repoPath: string): string {
  return join(repoPath, ".reposkein", "local", "temporal");
}

function cachePath(repoPath: string, headSha: string): string {
  return join(cacheDir(repoPath), `${headSha}.json`);
}

function readCache(path: string): TemporalStats | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // Invalidate if the cache was written by an older version of the algorithm
    if (parsed["_cache_version"] !== CACHE_VERSION) return null;
    return parsed as unknown as TemporalStats;
  } catch {
    return null;
  }
}

/**
 * Atomic write via a unique temp name → rename (no concurrent clobber).
 * The temp name includes PID + random suffix to avoid collisions when multiple
 * processes write concurrently. Best-effort: write failure must not break the tool.
 */
function writeCache(path: string, stats: TemporalStats): void {
  const rand = randomBytes(4).toString("hex");
  const tmp = `${path}.tmp-${process.pid}-${rand}`;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    // Embed version tag so future reads can detect stale caches
    const payload = { ...stats, _cache_version: CACHE_VERSION };
    writeFileSync(tmp, JSON.stringify(payload));
    renameSync(tmp, path);
  } catch {
    // best-effort; a write failure must not break the tool call
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Keep only the newest MAX_CACHE_FILES files; prune the rest (best-effort). */
function pruneCache(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const f of files.slice(MAX_CACHE_FILES)) {
      try { unlinkSync(join(dir, f.name)); } catch { /* ignore */ }
    }
  } catch {
    // best-effort
  }
}

// ── main export ──────────────────────────────────────────────────────────────

/**
 * Compute (or load from cache) temporal stats for all files in the repo.
 * Returns { unavailable: reason } if git is unavailable or repo has no history.
 * Never throws.
 */
export async function getTemporal(repoPath: string): Promise<TemporalResult> {
  try {
    // 1. Resolve HEAD sha
    const headResult = await getHeadSha(repoPath);
    if ("unavailable" in headResult) return headResult;
    const headSha = headResult.sha;

    // 2. Check cache
    const cPath = cachePath(repoPath, headSha);
    const cached = readCache(cPath);
    if (cached) return cached;

    // 3. Detect shallow clone
    const shallow = await isShallow(repoPath);

    // 4. Run git log
    const logArgs = [
      "log",
      "--no-merges",
      "--name-status",
      "-z",
      "--date=short",
      `--format=%x00%H%x1f%ad%x1f%aN%x1f%aE`,
      `--since=${WINDOW_MONTHS} months ago`,
      `-n`,
      String(MAX_COMMITS),
    ];
    const logResult = await gitExec(logArgs, repoPath);
    if (!logResult.ok) {
      if (logResult.maxBufferExceeded) {
        return { unavailable: "history too large for the temporal window" };
      }
      return { unavailable: `git log failed: ${logResult.error ?? "unknown error"}` };
    }

    const raw = logResult.stdout;
    if (!raw.trim()) {
      // No commits in window
      const stats: TemporalStats = {
        head_sha: headSha,
        shallow,
        files: {},
        cochange: {},
      };
      writeCache(cPath, stats);
      return stats;
    }

    // 5. Parse and compute
    const commits = parseGitLog(raw);
    const stats = computeTemporal(commits, {
      headSha,
      shallow,
      maxFilesPerCommit: COMMIT_SIZE_CAP,
      minSupport: MIN_SUPPORT,
    });

    // 6. Write cache and prune
    writeCache(cPath, stats);
    pruneCache(cacheDir(repoPath));

    return stats;
  } catch (err) {
    // Should not reach here — but fail safe
    return { unavailable: `unexpected error: ${(err as Error).message ?? String(err)}` };
  }
}
