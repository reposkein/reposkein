import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./doctor.js";
import { readIndexedAtSha } from "../store/indexedAt.js";
import { trackedGraphFiles } from "../store/trackedGraph.js";

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

/** `git -C repoPath rev-parse HEAD`, or null on any failure (no git, not a
 *  repo, no commits yet). */
function currentHeadSha(repoPath: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Content-based staleness: the committed graph is fresh iff the commit SHA
 *  recorded the last time it was (re)built (`.reposkein/local/indexed-at` —
 *  see mcp/src/store/indexedAt.ts) equals the current git HEAD. The marker
 *  is kept current two ways: the installed git hooks maintain it on their
 *  own (`post-commit` after every commit, `post-merge`/`post-checkout` —
 *  which also re-index — after a merge/pull/branch switch), and
 *  `reposkein-mcp index`/`init` write it directly. A mismatch therefore
 *  means one of: the hooks were never installed (or were removed), or
 *  nobody's indexed this repo at all yet.
 *
 *  Replaces an earlier mtime-based heuristic (mtime(nodes.jsonl) vs. the last
 *  commit's timestamp) that turned out to be structurally blind after any
 *  fresh checkout: `git clone`/`checkout` — or a CI cache restoring
 *  `.reposkein/` from a prior run — stamps every file it writes with
 *  "now", which is always ≥ any past commit's timestamp, so
 *  `mtime < lastCommitMs` could never be true right when it mattered most.
 *  A recorded SHA has no such blind spot: it's compared by value, not by
 *  filesystem timestamp.
 *
 *  Deliberately a **plain SHA mismatch**, not a diff filtered to
 *  indexed-language extensions: filtering would need to stay in sync with
 *  `config.toml`'s `[languages] enabled` list and the indexer's own
 *  extension→language table, which is one more thing to drift. The cost of
 *  getting it wrong is asymmetric — a false "stale" just costs a redundant
 *  `reposkein-mcp index` (cheap), while a false "fresh" is exactly the bug
 *  being fixed — so the simpler, conservative rule wins here.
 *
 *  Two distinct failure shapes, both reported under the same check id:
 *   - no recorded SHA at all → never indexed via a hook or the mcp-side path
 *     (a fresh clone's local/ never carries over, since it's gitignored) —
 *     FAIL.
 *   - a recorded SHA that doesn't match HEAD → the hooks are missing (or
 *     were bypassed, e.g. `git commit --no-verify`) and nobody's re-indexed
 *     by hand either — FAIL.
 *
 *  Non-critical by default; `doctor --ci` promotes it (CI_FAIL_IDS in
 *  doctor.ts). */
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

  const recordedSha = readIndexedAtSha(repoPath);
  if (!recordedSha) {
    return warn(
      "graph_stale",
      "graph freshness",
      false,
      "nodes.jsonl exists but no recorded indexed-at commit (.reposkein/local/indexed-at) — " +
        "the post-commit/post-merge/post-checkout hooks maintain this automatically, so its " +
        "absence means the hooks aren't installed (or local/ never carried over a clone) and " +
        "nobody's run `reposkein-mcp index`/`init` by hand either",
      "run `reposkein-mcp index`"
    );
  }

  const headSha = currentHeadSha(repoPath);
  if (headSha === null) {
    return warn("graph_stale", "graph freshness", true, "no git HEAD to compare against (skipped)");
  }

  if (recordedSha === headSha) {
    return warn("graph_stale", "graph freshness", true, `graph matches HEAD (${headSha.slice(0, 7)})`);
  }
  return warn(
    "graph_stale",
    "graph freshness",
    false,
    `graph was indexed at ${recordedSha.slice(0, 7)}, but HEAD is now ${headSha.slice(0, 7)} — commits landed since ` +
      "the last index without the marker advancing (hooks missing/bypassed, or the graph was never re-indexed)",
    "run `reposkein-mcp index`"
  );
}

/** Pre-0.2.7 adopters committed the derived graph; a tracked pair reached
 *  7.2MB (~1.9× a 1M-token context window) in the wild and repeatedly killed
 *  agents whose bare `git diff`/`gh pr diff` pulled it into context
 *  (REP-35). Non-critical (reads still work fine); `doctor --ci` promotes it
 *  — see CI_FAIL_IDS in doctor.ts. */
export function graphTrackedCheck(repoPath: string): Check {
  try {
    execFileSync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return warn("graph_tracked", "derived graph untracked", true, "not a git repository (skipped)");
  }
  const tracked = trackedGraphFiles(repoPath);
  if (tracked.length === 0) {
    return warn(
      "graph_tracked",
      "derived graph untracked",
      true,
      "nodes.jsonl / edges.jsonl are not tracked by git"
    );
  }
  return warn(
    "graph_tracked",
    "derived graph untracked",
    false,
    `${tracked.join(" + ")} are TRACKED in git — a bare \`git diff\`/\`git show\`/\`gh pr diff\` ` +
      "over this repo can pull the whole machine-generated graph into an agent's context window " +
      "and exhaust it",
    "run `reposkein-mcp migrate` (untracks the graph, refreshes .gitignore/.gitattributes/hooks), then commit"
  );
}
