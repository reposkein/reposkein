import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Directories never descended into while scanning for nested repos: build
 *  output, VCS internals, other worktrees/tool state — mirrors the skip set
 *  used by store/resolveRepoPath.ts's walk-down discovery. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  ".worktrees",
  ".claude",
]);

export interface FederatedRepo {
  /** repo_id from the nested repo's meta.json (or its directory name if the
   *  meta.json is missing/unreadable). */
  repoId: string;
  /** Path of the nested repo root, relative to the scanned root (posix-style). */
  rootPath: string;
  /** Absolute path of the nested repo root. */
  absPath: string;
}

/** Scans descendants of `repoPath` for nested repos (directories containing a
 *  `.reposkein/` marker), excluding `repoPath` itself. Does not recurse past a
 *  hit — a repo nested inside another nested repo is out of scope for a single
 *  export pass. Bounded to `maxDepth` levels (default 6) so a pathological
 *  tree can't cause an unbounded scan. Deterministic (sorted by rootPath).
 *  Best-effort: unreadable directories are skipped, never thrown. */
export function discoverFederatedRepos(repoPath: string, maxDepth = 6): FederatedRepo[] {
  const root = resolve(repoPath);
  const hits: FederatedRepo[] = [];

  function isReposkeinDir(dir: string): boolean {
    try {
      return statSync(join(dir, ".reposkein")).isDirectory();
    } catch {
      return false;
    }
  }

  function recurse(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't fail the export
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      if (entry.name === ".reposkein") continue;
      const full = join(dir, entry.name);
      if (isReposkeinDir(full)) {
        let repoId = entry.name;
        const metaPath = join(full, ".reposkein", "meta.json");
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
            if (typeof meta.repo_id === "string" && meta.repo_id) repoId = meta.repo_id;
          } catch {
            // fall back to the directory name
          }
        }
        hits.push({
          repoId,
          rootPath: relative(root, full).split("\\").join("/") || ".",
          absPath: full,
        });
        continue; // don't descend further into a hit
      }
      recurse(full, depth + 1);
    }
  }

  recurse(root, 1);
  return hits.sort((a, b) => (a.rootPath < b.rootPath ? -1 : a.rootPath > b.rootPath ? 1 : 0));
}
