/** Where a supporter token lives on disk, and the only code that puts it
 *  there.
 *
 *  ## User-level, never repo-level
 *
 *  Entitlement belongs to a PERSON, not to a checkout. Storing it under
 *  `.reposkein/` would be wrong three times over: it would ride into git (or
 *  need yet another ignore rule to stop it), it would be shared with everyone
 *  who clones the repo — handing them a token they did not pay for — and it
 *  would have to be re-supplied in every working copy by the one person who
 *  did. So it lives under the user's config directory and nothing in this
 *  package ever writes an entitlement byte inside a repository. There is a
 *  test that asserts exactly that by byte-comparing a repo tree across a
 *  `support` invocation.
 *
 *  ## Permissions
 *
 *  Directory 0700, file 0600, and the file mode is re-applied with an
 *  explicit `chmodSync` after every write: `writeFileSync`'s `mode` option is
 *  honoured only when the file is CREATED, so overwriting an existing
 *  world-readable token would otherwise silently leave it world-readable.
 *  The token is not a password — the worst a thief gets is no ads — but a
 *  paid entitlement is still the holder's to keep, and 0600 costs nothing.
 *
 *  On Windows these modes are approximated by the runtime; `--status` reports
 *  the mode it actually observes rather than asserting a POSIX guarantee the
 *  platform does not offer. */

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Overrides the entitlement file location. Exists for tests and for anyone
 *  running with an unusual HOME; it is NOT a bypass — the file it points at
 *  still has to contain a validly signed token, so redirecting it cannot
 *  manufacture entitlement. */
export const SUPPORTER_FILE_ENV = "REPOSKEIN_SUPPORTER_FILE";

const DIR_NAME = "reposkein";
const FILE_NAME = "supporter.jwt";

/** Resolves the entitlement file path, in order:
 *
 *   1. `REPOSKEIN_SUPPORTER_FILE`, if absolute.
 *   2. `$XDG_CONFIG_HOME/reposkein/supporter.jwt`, if absolute.
 *   3. `~/.config/reposkein/supporter.jwt` — the documented location. */
export function supporterTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[SUPPORTER_FILE_ENV] ?? "").trim();
  if (override && isAbsolute(override)) return override;
  const xdg = (env.XDG_CONFIG_HOME ?? "").trim();
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  return join(base, DIR_NAME, FILE_NAME);
}

export interface SupporterFileStat {
  mtimeMs: number;
  size: number;
  /** POSIX permission bits (`mode & 0o777`). */
  mode: number;
}

/** Cheap existence + identity probe. Returns null for "no file" and for any
 *  error reading it — an unreadable entitlement file is indistinguishable
 *  from an absent one as far as entitlement goes, and this runs on a tool
 *  call's hot path, so it must never throw. */
export function statSupporterTokenFile(env: NodeJS.ProcessEnv = process.env): SupporterFileStat | null {
  try {
    const st = statSync(supporterTokenPath(env));
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size, mode: st.mode & 0o777 };
  } catch {
    return null;
  }
}

/** Reads the token text, or null if there is nothing readable there. Never
 *  throws. Size is bounded by the caller's own token-length limit; a file
 *  larger than that fails verification rather than being read into memory
 *  blindly, so the read is capped here too. */
export function readSupporterTokenFile(env: NodeJS.ProcessEnv = process.env, maxBytes = 64 * 1024): string | null {
  try {
    const path = supporterTokenPath(env);
    const st = statSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    const text = readFileSync(path, "utf8").trim();
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

/** Writes the token, creating `~/.config/reposkein/` as 0700 if needed, and
 *  returns the path written. Throws on failure — this one is called from the
 *  CLI, where a failure must be reported, not swallowed. */
export function writeSupporterTokenFile(token: string, env: NodeJS.ProcessEnv = process.env): string {
  const path = supporterTokenPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token.trim()}\n`, { mode: 0o600 });
  // Re-assert: `mode` above applies only on creation.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Filesystems without POSIX modes (some Windows/network mounts). The
    // write itself succeeded, which is what the caller asked for.
  }
  return path;
}

/** Deletes the entitlement file. Returns true if a file was removed, false if
 *  there was nothing to remove. */
export function removeSupporterTokenFile(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = supporterTokenPath(env);
  try {
    statSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}
