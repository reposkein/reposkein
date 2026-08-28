import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  const hooksDir = resolveHooksDir(root);
  for (const name of HOOK_NAMES) {
    const p = join(hooksDir, name);
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
        `\n⚠ ${p} is not managed by RepoSkein but contains a \`git add .reposkein\` ` +
          "line — it will re-stage the derived graph on every commit and undo this migration. " +
          "Remove that line (or delete the hook and re-run `reposkein-mcp init` to install the " +
          "current one, which stages nothing)."
      );
    }
  }
}

/** Absolute path to the hooks directory actually consulted by git for
 *  `root` — the shared git-common-dir's `hooks/`, not `<root>/.git/hooks`,
 *  which for a linked worktree is a dangling path (`.git` there is a file,
 *  not a directory) even though the hooks it delegates to are real and
 *  live (N2 — a foreign staging hook in the main checkout's gitdir must
 *  still be caught while migrating a linked worktree). Falls back to
 *  `<root>/.git/hooks` if `git-common-dir` can't be resolved. */
function resolveHooksDir(root: string): string {
  try {
    const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    return join(commonDir, "hooks");
  } catch {
    return join(root, ".git", "hooks");
  }
}

/** Best-effort absolute path to the main checkout backing `root`'s git
 *  metadata. Equal to `root` itself for a normal repo; for a linked worktree
 *  it's the checkout that owns the shared `.git` directory (where hooks
 *  actually live). Returns "" when it can't be determined. */
function resolveMainCheckout(root: string): string {
  try {
    const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
    return commonDir.endsWith(".git") ? dirname(commonDir) : commonDir;
  } catch {
    return "";
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
 *      relied on. Skipped in a linked worktree (`.git` is a file there —
 *      hooks live in the main checkout) and degraded to a warning on any
 *      other hook-install failure — neither blocks the rest of the run.
 *   3. Re-indexes so `write_reposkein_layout` rewrites
 *      `.reposkein/.gitignore` + `.reposkein/.gitattributes` to the current
 *      templates.
 *
 *  Idempotent; a graceful no-op outside a git work tree (e.g. a workspace
 *  root holding .reposkein/ with no .git). `--dry-run` reports the same list
 *  of side effects without touching the git index, hooks, git config, or the
 *  `.reposkein` layout. */
export async function runMigrate(repoPath = ".", opts: RunMigrateOptions = {}): Promise<number> {
  let root = resolve(repoPath);
  try {
    git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    console.error(`reposkein migrate: ${root} is not a git repository — nothing to untrack.`);
    return 0;
  }
  // Normalize to the work-tree root (C1): a caller passing a subdirectory
  // (or a programmatic caller passing anything but the root) would otherwise
  // have every `git` pathspec below miss, reading as "not tracked", while
  // the indexer step below would happily write .git/hooks + a stray
  // .reposkein INTO the subdirectory. Guarded (N1): a nested RepoSkein root
  // (a monorepo package with its own `.reposkein/`) is a real, intentional
  // migrate target — walking it up to the outer work-tree root would migrate
  // the wrong `.reposkein` entirely, so only normalize when the passed dir
  // isn't itself one.
  if (!existsSync(join(root, ".reposkein"))) {
    root = git(root, ["rev-parse", "--show-toplevel"]).trim();
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
  // .reposkein/.gitignore + .gitattributes templates. Neither a skipped nor
  // a failed hook install (I2) blocks the rest of the run — the untracking
  // above is the part that matters most, and both degrade to a warning.
  const gitEntry = join(root, ".git");
  let skipHooks = false;
  if (existsSync(gitEntry) && statSync(gitEntry).isFile()) {
    skipHooks = true;
    const mainCheckout = resolveMainCheckout(root);
    console.error(
      "reposkein migrate: this is a linked worktree (`.git` here is a file, not a directory) — " +
        "git hooks live in the main checkout" +
        (mainCheckout ? ` at ${mainCheckout}` : "") +
        "; skipping hook install here. Run `reposkein-mcp init`" +
        (mainCheckout ? ` in ${mainCheckout}` : "") +
        " to (re)install them there."
    );
  }

  const bin = await ensureIndexerBinary();
  if (!skipHooks) {
    const hooks = await spawnIndexer(bin, ["init", "--hooks", root]);
    if (hooks.code !== 0) {
      console.error(
        `reposkein migrate: hook install failed (continuing without hooks): ${hooks.stderr || hooks.stdout}`
      );
    }
  }
  const idx = await runIndex(root);

  warnForeignStagingHooks(root);

  if (idx !== 0) return idx;

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
