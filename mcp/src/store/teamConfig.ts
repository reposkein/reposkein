import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Reads one `key = "value"` from one `[section]` of `.reposkein/config.toml`,
 *  or null when the file, section, key, or quoting is absent.
 *
 *  A deliberate ~25-line scanner rather than a TOML dependency — mirrors
 *  `config_bool` in indexer/crates/cli/src/main.rs: this reads a handful of
 *  scalar settings out of a file `reposkein-indexer init` writes. Unquoted
 *  values yield null on purpose (the writer always quotes; an unquoted value
 *  is a hand-edit we refuse to guess at). */
export function readConfigString(repoPath: string, section: string, key: string): string | null {
  const path = join(repoPath, ".reposkein", "config.toml");
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const header = `[${section}]`;
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inSection = line === header;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    const rawValue = line.slice(eq + 1).split("#")[0]!.trim();
    const quoted = rawValue.match(/^"([^"]*)"$/) ?? rawValue.match(/^'([^']*)'$/);
    return quoted ? quoted[1]! : null;
  }
  return null;
}

/** Reads `pages_url` from the `[team]` section of `.reposkein/config.toml`,
 *  or null when the file/section/key is absent (the common case — this is
 *  an opt-in field a team adds after publishing a hosted constellation, see
 *  docs/HOSTING.md). Points the viewer's header at wherever the team's
 *  canonical/CI-published constellation lives (e.g. a GitHub Pages URL),
 *  distinct from whatever ad-hoc `view`/`view --export` a given machine
 *  happens to be looking at right now. */
export function readTeamPagesUrl(repoPath: string): string | null {
  return readConfigString(repoPath, "team", "pages_url");
}
