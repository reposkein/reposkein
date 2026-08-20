import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  countRecordedConflicts,
  isShardFileName,
  loadSummaryShards,
  summariesDir,
} from "../store/summaryShards.js";
import type { Check } from "./doctor.js";

/** Health of the committed authored summaries, `.reposkein/summaries/<xx>.jsonl`.
 *
 *  Every check is non-critical. Summaries are the one part of `.reposkein/`
 *  nothing can regenerate, so the failure mode that matters is *silent* loss:
 *  prose that exists on disk but will never be committed, or a merge that
 *  dropped a record. Each check below names one way that happens.
 *
 *  Returns [] when the repo has no committed summaries and no legacy file —
 *  a repo that has never had an agent write one has nothing to report. */

const warn = (id: string, label: string, ok: boolean, detail: string, fix?: string): Check => ({
  id,
  label,
  ok,
  critical: false,
  detail,
  fix: ok ? undefined : fix,
});

/** `git check-ignore -v <path>`, or null when the path is not ignored (or git
 *  is unavailable / this is not a repo). The verbose form names the source:
 *  `<file>:<line>:<pattern>\t<path>`. */
function checkIgnoreSource(repoPath: string, relPath: string): string | null {
  try {
    const out = execFileSync("git", ["-C", repoPath, "check-ignore", "-v", "--no-index", relPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out.split("\n")[0]?.trim();
    return first ? first.split("\t")[0]! : null;
  } catch {
    // exit 1 = not ignored; anything else = no git. Both mean "no finding".
    return null;
  }
}

export function summaryChecks(repoPath: string): Check[] {
  const dir = summariesDir(repoPath);
  let shardCount = 0;
  try {
    shardCount = readdirSync(dir).filter(isShardFileName).length;
  } catch {
    shardCount = 0;
  }
  const legacyPresent = existsSync(join(repoPath, ".reposkein", "summaries.jsonl"));
  if (shardCount === 0 && !legacyPresent) return [];

  const checks: Check[] = [];
  const loaded = loadSummaryShards(repoPath);

  // 1) The pre-sharding single file is still there.
  //
  //    One committed summaries.jsonl is exactly the artifact that made every
  //    branch conflict — the #35 lesson. It is read for one release so nothing
  //    is stranded, but leaving it is a conflict waiting to happen.
  checks.push(
    warn(
      "summaries_unsplit",
      "summaries sharded",
      !legacyPresent,
      legacyPresent
        ? `.reposkein/summaries.jsonl is still present (${loaded.summaries.size} record(s) readable); every branch that writes a summary will conflict on it`
        : `${shardCount} shard(s), ${loaded.summaries.size} summar${loaded.summaries.size === 1 ? "y" : "ies"}`,
      "run `reposkein-indexer index .` — it folds the file into .reposkein/summaries/<xx>.jsonl and retires it; commit the result"
    )
  );

  // 2) A .gitignore pattern is masking the shards.
  //
  //    A repo-root rule like `.reposkein/*` (or a blanket `*.jsonl`) silently
  //    keeps the shards out of every commit. Nothing errors — the summaries
  //    simply never reach a teammate, and are lost with the machine.
  const probe = shardCount > 0 ? firstShardRelPath(repoPath) : ".reposkein/summaries/00.jsonl";
  const ignoredBy = checkIgnoreSource(repoPath, probe);
  checks.push(
    warn(
      "summaries_committable",
      "summary shards committable",
      ignoredBy === null,
      ignoredBy === null
        ? "not git-ignored"
        : `${probe} is ignored by ${ignoredBy} — authored summaries would never be committed`,
      "add a negation after that rule, e.g. `!**/.reposkein/summaries/`, then `git add .reposkein/summaries`"
    )
  );

  // 3) Damaged shard content: conflict markers or unparseable lines.
  checks.push(
    warn(
      "summaries_readable",
      "summary shards parse",
      loaded.warnings.length === 0,
      loaded.warnings.length === 0
        ? `${loaded.summaries.size} record(s) read cleanly`
        : loaded.warnings.join("; "),
      "run `reposkein-indexer index .` to rewrite the shards canonically, then commit them"
    )
  );

  // 4) Divergent records preserved from a merge. Not an error — the resolution
  //    is deterministic — but a human should read the loser before it is
  //    forgotten, because nothing can regenerate it.
  const conflicts = countRecordedConflicts(repoPath);
  checks.push(
    warn(
      "summaries_conflicts",
      "summary merge conflicts",
      conflicts === 0,
      conflicts === 0
        ? "none recorded"
        : `${conflicts} record(s) lost a merge tiebreak and were preserved in .reposkein/local/conflicts.jsonl`,
      "read .reposkein/local/conflicts.jsonl; re-write any summary worth keeping, then delete the file"
    )
  );

  return checks;
}

function firstShardRelPath(repoPath: string): string {
  try {
    const names = readdirSync(summariesDir(repoPath)).filter(isShardFileName).sort();
    if (names[0]) return `.reposkein/summaries/${names[0]}`;
  } catch {
    // fall through
  }
  return ".reposkein/summaries/00.jsonl";
}
