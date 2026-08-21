import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Reads `pages_url` from the `[team]` section of `.reposkein/config.toml`,
 *  or null when the file/section/key is absent (the common case — this is
 *  an opt-in field a team adds after publishing a hosted constellation, see
 *  docs/HOSTING.md). Points the viewer's header at wherever the team's
 *  canonical/CI-published constellation lives (e.g. a GitHub Pages URL),
 *  distinct from whatever ad-hoc `view`/`view --export` a given machine
 *  happens to be looking at right now.
 *
 *  A deliberate ~20-line scanner rather than a TOML dependency — mirrors
 *  `config_bool` in indexer/crates/cli/src/main.rs: this reads exactly one
 *  setting, and its config is a file `reposkein-indexer init` writes.
 *  Absent file, section, or key all mean `null`. */
export function readTeamPagesUrl(repoPath: string): string | null {
  const path = join(repoPath, ".reposkein", "config.toml");
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let inTeamSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inTeamSection = line === "[team]";
      continue;
    }
    if (!inTeamSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key !== "pages_url") continue;
    const rawValue = line.slice(eq + 1).split("#")[0]!.trim();
    const quoted = rawValue.match(/^"([^"]*)"$/) ?? rawValue.match(/^'([^']*)'$/);
    return quoted ? quoted[1]! : null;
  }
  return null;
}
