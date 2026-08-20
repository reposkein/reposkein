import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { resolveRepoPath, walkUp, walkDown, type RepoResolution } from "./resolveRepoPath.js";

export interface RepoInfo {
  path: string;
  /** From <path>/.reposkein/meta.json, when present. */
  repo_id?: string;
  /** Display name: repo_id if meta.json resolved one, else the directory's
   *  basename — always present so `select_repo` has something to match on
   *  even before the repo has been indexed (no meta.json yet). */
  name: string;
  /** Cheap line counts (not full parses) — omitted where the file is absent. */
  nodes?: number;
  edges?: number;
}

function countLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim()) n++;
  return n;
}

function readMetaRepoId(path: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(path, ".reposkein", "meta.json"), "utf8"));
    return typeof meta.repo_id === "string" ? meta.repo_id : undefined;
  } catch {
    return undefined;
  }
}

/** Line counts for nodes.jsonl / edges.jsonl if they exist — the same cheap
 *  "count non-empty lines" approach `cli/doctor.ts` uses, not a full parse. */
function cheapCounts(path: string): { nodes?: number; edges?: number } {
  const out: { nodes?: number; edges?: number } = {};
  const nodesFile = join(path, ".reposkein", "nodes.jsonl");
  const edgesFile = join(path, ".reposkein", "edges.jsonl");
  try {
    if (existsSync(nodesFile)) out.nodes = countLines(readFileSync(nodesFile, "utf8"));
  } catch {
    /* unreadable — omit rather than fail list_repos over one repo */
  }
  try {
    if (existsSync(edgesFile)) out.edges = countLines(readFileSync(edgesFile, "utf8"));
  } catch {
    /* unreadable — omit */
  }
  return out;
}

export function describeRepo(path: string): RepoInfo {
  const repo_id = readMetaRepoId(path);
  return {
    path,
    ...(repo_id ? { repo_id } : {}),
    name: repo_id ?? basename(path),
    ...cheapCounts(path),
  };
}

/** Every repo `list_repos` should report. Deliberately broader than
 *  `resolveRepoPath`'s own short-circuiting precedence: discovery always
 *  walks the filesystem (nearest ancestor with `.reposkein/`, else
 *  subdirectories) so a workspace's sibling repos are visible — and thus
 *  selectable via `select_repo` — even in a session where REPOSKEIN_REPO_PATH
 *  happens to pin one of them. That env pin is unioned in (deduped) so it's
 *  never missing from the list, but it does not suppress the others; only
 *  `resolveRepoPath`'s actual *default* pick (used by `resolve()` below)
 *  gives it priority over the walk. Sorted for deterministic output. */
export function discoverRepoPaths(opts: { cwd: string; envRepoPath?: string }): string[] {
  const up = walkUp(opts.cwd);
  const physical = up ? [up] : walkDown(opts.cwd);
  if (opts.envRepoPath && !physical.includes(opts.envRepoPath)) {
    return [...physical, opts.envRepoPath].sort();
  }
  return physical;
}

/** Tracks the MCP session's active repo across tool calls.
 *
 *  Resolution precedence: `select_repo` (session-only; sticky for the rest of
 *  the connection) > REPOSKEIN_REPO_PATH > walk-up > walk-down. `select_repo`
 *  is deliberately allowed to override REPOSKEIN_REPO_PATH once called — it's
 *  the more specific, more recent signal, and it's how a workspace-mode
 *  session (multiple sibling repos, walk-down ambiguous) picks one to work
 *  with instead of restarting the server with a different env var. */
export class RepoSession {
  private readonly cwd: string;
  private readonly envRepoPath: string | undefined;
  private selectedPath: string | undefined;

  constructor(opts: { cwd: string; envRepoPath: string | undefined }) {
    this.cwd = opts.cwd;
    this.envRepoPath = opts.envRepoPath;
  }

  /** Current resolution, honoring an active `select_repo` pick first. */
  resolve(): RepoResolution {
    if (this.selectedPath) return { repoPath: this.selectedPath, source: "explicit" };
    return resolveRepoPath({ cwd: this.cwd, envRepoPath: this.envRepoPath });
  }

  /** Every candidate repo for this session — see `discoverRepoPaths`. Each
   *  entry is flagged `selected` for whichever one `resolve()` currently
   *  returns, so an agent can see the effect of a prior `select_repo` call. */
  list(): (RepoInfo & { selected: boolean })[] {
    const active = this.resolve().repoPath;
    return discoverRepoPaths({ cwd: this.cwd, envRepoPath: this.envRepoPath }).map((path) => ({
      ...describeRepo(path),
      selected: path === active,
    }));
  }

  /** Sets the session-active repo by path, by its meta.json `repo_id`, or by
   *  display `name` (as returned by `list()`/`list_repos`) — never an
   *  arbitrary filesystem path, so this can't be used to point outside what
   *  resolution actually discovered. */
  select(pathOrName: string): { ok: true; repo: RepoInfo } | { ok: false; error: string } {
    const candidates = discoverRepoPaths({ cwd: this.cwd, envRepoPath: this.envRepoPath }).map(describeRepo);
    const hit =
      candidates.find((c) => c.path === pathOrName) ??
      candidates.find((c) => c.repo_id === pathOrName) ??
      candidates.find((c) => c.name === pathOrName);
    if (!hit) {
      return {
        ok: false,
        error:
          `No repo matching "${pathOrName}" among the discovered candidates` +
          (candidates.length > 0
            ? `: ${candidates.map((c) => c.path).join(", ")}.`
            : " (none found).") +
          " Call list_repos first and pass one of its `path` or `name` values.",
      };
    }
    this.selectedPath = hit.path;
    return { ok: true, repo: hit };
  }
}
