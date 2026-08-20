import { readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

const REPOSKEIN_DIR = ".reposkein";

/** Directories never treated as repo candidates while walking down: build
 *  output, VCS internals, other worktrees/tool state — never real repo roots. */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "target", "dist", ".worktrees", ".claude"]);

export type RepoResolutionSource = "explicit" | "env" | "walk-up" | "walk-down" | "none";

export interface RepoResolution {
  /** Resolved repo root, or undefined if none could be determined. */
  repoPath: string | undefined;
  /** How repoPath was determined ("none" when nothing resolved). */
  source: RepoResolutionSource;
  /** Populated only when source is "none" because walk-down found 2+ hits
   *  (workspace mode, ambiguous) — name them so the caller can pick one. */
  candidates?: string[];
}

function hasReposkeinDir(dir: string): boolean {
  try {
    return statSync(join(dir, REPOSKEIN_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/** Nearest ancestor of `cwd` (inclusive) containing `.reposkein/`. */
export function walkUp(cwd: string): string | undefined {
  let dir = resolvePath(cwd);
  for (;;) {
    if (hasReposkeinDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

/** Scans descendants of `cwd` (bounded to `maxDepth` levels, skipping
 *  build/VCS/tool directories) for directories containing `.reposkein/`.
 *  Does not recurse further into a hit — nested repos are a graph-federation
 *  concern (see store/federation.ts), not a workspace-candidate one here.
 *  Returns hits sorted for deterministic ambiguity-error output. */
export function walkDown(cwd: string, maxDepth = 2): string[] {
  const root = resolvePath(cwd);
  const hits: string[] = [];

  function recurse(dir: string, depth: number): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, race) — skip, don't fail resolution
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === REPOSKEIN_DIR) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (hasReposkeinDir(full)) {
        hits.push(full);
        continue;
      }
      if (depth < maxDepth) recurse(full, depth + 1);
    }
  }

  recurse(root, 1);
  return hits.sort();
}

/** Zero-config repo resolution.
 *
 *  Precedence: explicit tool arg > REPOSKEIN_REPO_PATH > walk-up > walk-down.
 *  - Walk-up: nearest ancestor of `cwd` (inclusive) containing `.reposkein/`.
 *  - Walk-down (workspace mode, only tried when no ancestor has one): scans
 *    `cwd`'s children/grandchildren for `.reposkein/` dirs. One hit auto-
 *    selects it. Zero or 2+ hits leave `repoPath` undefined ("none"); 2+
 *    populates `candidates` so the caller can build an actionable error. */
export function resolveRepoPath(opts: {
  cwd: string;
  envRepoPath?: string;
  explicit?: string;
}): RepoResolution {
  if (opts.explicit) return { repoPath: opts.explicit, source: "explicit" };
  if (opts.envRepoPath) return { repoPath: opts.envRepoPath, source: "env" };

  const up = walkUp(opts.cwd);
  if (up) return { repoPath: up, source: "walk-up" };

  const down = walkDown(opts.cwd);
  if (down.length === 1) return { repoPath: down[0], source: "walk-down" };
  if (down.length > 1) return { repoPath: undefined, source: "none", candidates: down };
  return { repoPath: undefined, source: "none" };
}
