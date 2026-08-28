import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { trackedGraphFiles, GRAPH_FILES } from "../store/trackedGraph.js";
import { ensureIndexerBinary } from "../indexer/fetchBinary.js";
import { spawnIndexer } from "../indexer/runIndexer.js";
import { runIndex } from "./init.js";

/** Same marker `init --hooks` writes — see indexer/crates/cli/src/main.rs. */
const HOOK_MARKER = "# reposkein-managed";
const HOOK_NAMES = ["pre-commit", "post-commit", "post-merge", "post-checkout"] as const;

export interface RunMigrateOptions {
  /** Report what would change without touching the git index, hooks, config, or layout. */
  dryRun?: boolean;
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Repo-relative paths of the derived graph files STAGED for deletion but not
 *  yet committed — i.e. `git rm --cached` already ran this migration (or a
 *  prior, interrupted one) but the resulting commit hasn't happened yet.
 *  `trackedGraphFiles` alone goes empty the moment the deletion is staged, so
 *  a retry after a hook/reindex failure would otherwise lose the "you still
 *  need to commit" reminder — this probe keeps it alive until the commit
 *  actually happens. */
function stagedGraphDeletions(repoPath: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", repoPath, "diff", "--cached", "--name-only", "--diff-filter=D", "--", ...GRAPH_FILES],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Pre-0.2.7 hooks did `git add .reposkein/...` themselves. `init --hooks`
 *  refuses to overwrite a hook without the managed marker, so such a hook
 *  survives every upgrade silently — this scan makes it loud instead. */
function warnForeignStagingHooks(root: string): void {
  for (const name of HOOK_NAMES) {
    const p = join(root, ".git", "hooks", name);
    if (!existsSync(p)) continue;
    let content = "";
    try {
      content = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (content.includes(HOOK_MARKER)) continue;
    if (/git add[^\n]*\.reposkein/.test(content)) {
      console.error(
        `\n⚠ .git/hooks/${name} is not managed by RepoSkein but contains a \`git add .reposkein\` ` +
          "line — it will re-stage the derived graph on every commit and undo this migration. " +
          "Remove that line (or delete the hook and re-run `reposkein-mcp init` to install the " +
          "current one, which stages nothing)."
      );
    }
  }
}

/** `reposkein-mcp migrate [path] [--dry-run]`: one-command repair for repos
 *  that still track the derived graph (pre-0.2.7 adopters — REP-35).
 *
 *  Side effects on a real run (none of them commit anything):
 *   1. Untracks nodes.jsonl/edges.jsonl via `git rm --cached` — STAGED only,
 *      never committed; the files stay on disk.
 *   2. Refreshes the managed git hooks (`indexer init --hooks`), which as a
 *      side effect also strips the legacy merge-driver lines from the
 *      repo-root `.gitattributes` (e.g. `nodes.jsonl merge=reposkein-jsonl`)
 *      and unsets the `merge.reposkein-jsonl.*` git config those lines
 *      relied on.
 *   3. Re-indexes so `write_reposkein_layout` rewrites
 *      `.reposkein/.gitignore` + `.reposkein/.gitattributes` to the current
 *      templates.
 *
 *  Idempotent; a graceful no-op outside a git work tree (e.g. a workspace
 *  root holding .reposkein/ with no .git). `--dry-run` reports the same list
 *  of side effects without touching the git index, hooks, git config, or the
 *  `.reposkein` layout. */
export async function runMigrate(repoPath = ".", opts: RunMigrateOptions = {}): Promise<number> {
  const root = resolve(repoPath);
  try {
    git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    console.error(`reposkein migrate: ${root} is not a git repository — nothing to untrack.`);
    return 0;
  }

  const commitCmd = `  git -C ${root} commit -m "chore(reposkein): stop tracking the derived graph"`;
  const commitReminder = "Commit the staged untracking (migrate never commits for you):\n" + commitCmd;

  const tracked = trackedGraphFiles(root);

  if (opts.dryRun) {
    console.error(
      tracked.length > 0
        ? `reposkein migrate (dry-run): would untrack ${tracked.join(", ")} (git rm --cached), ` +
            "refresh git hooks, strip the legacy merge-driver lines from the repo-root " +
            ".gitattributes, unset the merge.reposkein-jsonl.* git config, and rewrite " +
            ".reposkein/.gitignore + .gitattributes via a fresh index. Nothing was changed."
        : "reposkein migrate (dry-run): derived graph is not tracked; would still refresh git " +
            "hooks, strip the legacy merge-driver lines from the repo-root .gitattributes, " +
            "unset the merge.reposkein-jsonl.* git config, and rewrite the .reposkein templates " +
            "via a fresh index. Nothing was changed."
    );
    return 0;
  }

  if (tracked.length > 0) {
    git(root, ["rm", "--cached", "--quiet", "--", ...tracked]);
    // Print the full commit command right away — a hook/reindex failure
    // below must not be the only chance the operator sees it (Finding 2).
    console.error(
      `reposkein migrate: untracked ${tracked.join(", ")} — deletion is STAGED, files stay on disk.\n` +
        commitReminder
    );
  } else {
    console.error("reposkein migrate: derived graph is not tracked — nothing to untrack.");
  }

  // Hooks first (also strips the legacy merge-driver lines from the
  // repo-root .gitattributes and unsets merge.reposkein-jsonl.* git config),
  // then a fresh index so write_reposkein_layout rewrites the
  // .reposkein/.gitignore + .gitattributes templates.
  const bin = await ensureIndexerBinary();
  const hooks = await spawnIndexer(bin, ["init", "--hooks", root]);
  if (hooks.code !== 0) {
    console.error(`reposkein migrate: hook install failed: ${hooks.stderr || hooks.stdout}`);
    return 1;
  }
  const idx = await runIndex(root);
  if (idx !== 0) return idx;

  warnForeignStagingHooks(root);

  // Re-probe rather than trusting `tracked` alone: on a retry after an
  // earlier interrupted run, `git rm --cached` already happened (so
  // `tracked` above reads empty) but the deletion is still only staged —
  // `stagedGraphDeletions` catches that case so the reminder survives.
  const needsCommit = tracked.length > 0 || stagedGraphDeletions(root).length > 0;
  if (needsCommit) {
    console.error("\nDone. " + commitReminder);
  }
  console.error("Verify with `reposkein-mcp doctor` — the `graph_tracked` check should pass.");
  return 0;
}
