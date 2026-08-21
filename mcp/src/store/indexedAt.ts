import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Path to the file recording the git commit SHA that was HEAD the last time
 *  the mcp-side index invocation path (`reposkein-mcp index`, or `init`'s
 *  initial index) completed successfully. Lives under `.reposkein/local/` —
 *  per-machine scratch that's gitignored and never committed — so it never
 *  survives a `git clone`. That's deliberate: a fresh clone has no idea what
 *  commit (if any) its nonexistent graph was built from, which is exactly
 *  the state `doctor --ci`'s `graph_stale` check should fail on. */
export function indexedAtPath(repoPath: string): string {
  return join(repoPath, ".reposkein", "local", "indexed-at");
}

/** Records the current git HEAD as "the commit the graph was just built
 *  from". Best-effort and silent: not a git repo / no HEAD yet / a read-only
 *  filesystem all just skip the write — `graph_stale` degrades to "never
 *  recorded" (fails, conservatively) rather than the index step itself
 *  failing over a scratch-file write. */
export function writeIndexedAtMarker(repoPath: string): void {
  let sha: string;
  try {
    sha = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
  if (!sha) return;
  try {
    const path = indexedAtPath(repoPath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, sha + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

/** Reads the recorded indexed-at SHA, or null when never recorded — never
 *  indexed via the mcp-side path, or a fresh clone (local/ isn't committed,
 *  so it never carries over). */
export function readIndexedAtSha(repoPath: string): string | null {
  const path = indexedAtPath(repoPath);
  if (!existsSync(path)) return null;
  try {
    const sha = readFileSync(path, "utf8").trim();
    return sha || null;
  } catch {
    return null;
  }
}
