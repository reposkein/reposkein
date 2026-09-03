import { execFileSync } from "node:child_process";

/** The derived graph files that must never be tracked (repo-relative). */
export const GRAPH_FILES = [".reposkein/nodes.jsonl", ".reposkein/edges.jsonl"] as const;

/** Repo-relative paths of the derived graph files git currently TRACKS at
 *  `repoPath` — `[]` when untracked, or when there is no git repo at all.
 *  Pre-0.2.7 adopters committed these; a tracked pair reached 7.2MB (~1.9×
 *  a 1M-token context window) in the wild, so every surface that can steer
 *  an agent (doctor, migrate, the MCP session warning) keys off this one
 *  probe. */
export function trackedGraphFiles(repoPath: string): string[] {
  try {
    const out = execFileSync("git", ["-C", repoPath, "ls-files", "--", ...GRAPH_FILES], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return []; // no git / not a work tree → nothing can be tracked
  }
}

/** Agent-facing warning for a repo whose derived graph is tracked, or
 *  undefined when it isn't. One string, reused verbatim by doctor's detail,
 *  the MCP once-per-session warning, and `list_repos` — the copy names both
 *  the permanent fix and the interim escape hatch. */
export function trackedGraphWarning(repoPath: string): string | undefined {
  const tracked = trackedGraphFiles(repoPath);
  if (tracked.length === 0) return undefined;
  return (
    `⚠ ${tracked.join(" + ")} are TRACKED in git at ${repoPath}. A bare \`git diff\`, ` +
    "`git show`, `git status -v`, or `gh pr diff` there can pull megabytes of machine-" +
    "generated JSONL into a context window and exhaust it. Permanent fix: run " +
    `\`reposkein-mcp migrate ${repoPath}\` and commit the staged untracking. Until then, ` +
    "always scope diffs, e.g. `git diff -- . ':(exclude).reposkein'`."
  );
}
