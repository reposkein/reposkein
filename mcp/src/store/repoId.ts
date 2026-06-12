import { readFileSync } from "node:fs";
import { join } from "node:path";

/** repo_id resolution: REPOSKEIN_REPO_ID env override, else
 *  <repoPath>/.reposkein/meta.json's repo_id. Returns undefined if neither. */
export function resolveRepoId(repoPath: string | undefined, envRepoId: string | undefined): string | undefined {
  if (envRepoId) return envRepoId;
  if (!repoPath) return undefined;
  try {
    const meta = JSON.parse(readFileSync(join(repoPath, ".reposkein", "meta.json"), "utf8"));
    return typeof meta.repo_id === "string" ? meta.repo_id : undefined;
  } catch {
    return undefined;
  }
}
