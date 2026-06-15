/**
 * MCP tool handler: get_temporal_context(path)
 *
 * Returns git-derived co-change, churn, and ownership signals for a file.
 * These are advisory (derived from git history, not the committed graph) and
 * never enter committed JSONL. Computed lazily from .git, cached by HEAD sha.
 */

import { getTemporal } from "../temporal/temporal.js";
import type { ToolResult } from "./readCypher.js";
import type { TemporalStats } from "../temporal/gitlog.js";

export interface TemporalContextArgs {
  path: string;
}

export function makeTemporalContext(repoPath: string) {
  return async (args: TemporalContextArgs): Promise<ToolResult> => {
    const result = await getTemporal(repoPath);

    // git unavailable or repo has no history
    if ("unavailable" in result) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            unavailable: result.unavailable,
            note: "git temporal context is not available for this repository",
          }),
        }],
      };
    }

    const stats = result as TemporalStats;
    const filePath = args.path;

    const fileStats = stats.files[filePath];
    const cochanged = stats.cochange[filePath];

    if (!fileStats) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            path: filePath,
            head_sha: stats.head_sha,
            note: "no history (new/untracked file or outside the window)",
            ...(stats.shallow ? { advisory: "shallow clone — history is partial" } : {}),
          }),
        }],
      };
    }

    const response: Record<string, unknown> = {
      path: filePath,
      head_sha: stats.head_sha,
      ...(stats.shallow ? { advisory: "shallow clone detected — counts reflect partial history" } : {}),
      change_count: fileStats.change_count,
      last_changed: fileStats.last_changed,
      top_authors: fileStats.authors,
      co_changed: cochanged ?? [],
    };

    return {
      content: [{ type: "text", text: JSON.stringify(response) }],
    };
  };
}
