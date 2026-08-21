import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./doctor.js";

/** Marker `init --hooks` (the Rust indexer) writes into every hook it
 *  installs — see indexer/crates/cli/src/main.rs `write_hook`. Doctor uses
 *  the same marker to tell "RepoSkein installed this hook" from "the user
 *  has their own pre-commit hook and never ran `reposkein-mcp init`". */
const HOOK_MARKER = "# reposkein-managed";

const warn = (id: string, label: string, ok: boolean, detail: string, fix?: string): Check => ({
  id,
  label,
  ok,
  critical: false, // these checks degrade the workflow; they never block startup
  detail,
  fix: ok ? undefined : fix,
});

/** Non-critical by default: a repo can be perfectly usable without hooks
 *  (an agent can always run `reposkein-mcp index` by hand). `doctor --ci`
 *  promotes this id to a failing exit code — see CI_FAIL_IDS in doctor.ts. */
export function hooksCheck(repoPath: string): Check {
  const hookPath = join(repoPath, ".git", "hooks", "pre-commit");
  if (!existsSync(hookPath)) {
    return warn(
      "hooks_installed",
      "git hooks installed",
      false,
      "no .git/hooks/pre-commit",
      "run `reposkein-mcp init` to install the pre-commit/post-merge hooks"
    );
  }
  let content = "";
  try {
    content = readFileSync(hookPath, "utf8");
  } catch {
    /* unreadable — treat like missing below */
  }
  const managed = content.includes(HOOK_MARKER);
  return warn(
    "hooks_installed",
    "git hooks installed",
    managed,
    managed
      ? "pre-commit hook installed"
      : ".git/hooks/pre-commit exists but was not installed by RepoSkein",
    managed ? undefined : "run `reposkein-mcp init` to install the pre-commit/post-merge hooks"
  );
}

/** `git -C repoPath log -1 --format=%ct` for the given pathspec, or null on
 *  any failure (no git, not a repo, no commits, no matching commit). */
function lastCommitEpochMs(repoPath: string, pathspec: string[]): number | null {
  try {
    const out = execFileSync("git", ["-C", repoPath, "log", "-1", "--format=%ct", "--", ...pathspec], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    const sec = parseInt(out, 10);
    return Number.isFinite(sec) ? sec * 1000 : null;
  } catch {
    return null;
  }
}

/** Pragmatic staleness heuristic: the committed graph (`.reposkein/nodes.jsonl`)
 *  should be at least as new as the last commit that touched tracked files
 *  outside `.reposkein/` (a commit that only edits summaries/decisions
 *  doesn't require a re-index). Compares mtimes, not content — cheap, no
 *  hashing, and good enough to catch "forgot to re-index after a big change".
 *
 *  Known limitation (documented, not fixed): `git checkout`/`clone` sets
 *  every file's mtime to checkout time, not commit time, so a fresh clone's
 *  nodes.jsonl (rebuilt by `init`/hooks right after) usually reads as fresh
 *  by construction, and a long-lived local checkout is the case this most
 *  reliably catches. Non-critical by default; `doctor --ci` promotes it. */
export function graphStaleCheck(repoPath: string): Check {
  const nodesFile = join(repoPath, ".reposkein", "nodes.jsonl");
  if (!existsSync(nodesFile)) {
    return warn(
      "graph_stale",
      "graph freshness",
      false,
      "no .reposkein/nodes.jsonl (never indexed)",
      "run `reposkein-mcp index`"
    );
  }
  // Exclude .reposkein/ itself (summaries/decisions land there and don't
  // require a re-index) with git's exclude pathspec magic; fall back to an
  // unscoped query on older git versions that reject it.
  let lastCommitMs = lastCommitEpochMs(repoPath, [".", ":(exclude).reposkein"]);
  if (lastCommitMs === null) lastCommitMs = lastCommitEpochMs(repoPath, ["."]);
  if (lastCommitMs === null) {
    return warn("graph_stale", "graph freshness", true, "no git history to compare against (skipped)");
  }
  const mtimeMs = statSync(nodesFile).mtimeMs;
  const stale = mtimeMs < lastCommitMs;
  return warn(
    "graph_stale",
    "graph freshness",
    !stale,
    stale
      ? "nodes.jsonl is older than the last commit touching tracked files outside .reposkein/"
      : "graph is at least as new as the last relevant commit",
    stale ? "run `reposkein-mcp index`" : undefined
  );
}
