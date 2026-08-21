import { createHash, timingSafeEqual } from "node:crypto";
import { readConfigString } from "../store/teamConfig.js";

/** One bearer credential a `serve --http` operator handed out (REP-17).
 *
 *  `name` is NOT a secret: it is the connection's writer identity, landing in
 *  `summary_by` / `decided_by` and selecting the per-agent sidecar file. It is
 *  the thing that gets logged. `token` is the secret and is never logged,
 *  printed, or echoed into a tool result. */
export interface ServeToken {
  name: string;
  token: string;
  /** True only for entries declared `name:token:write`. */
  write: boolean;
}

export interface ParsedTokens {
  tokens: ServeToken[];
  /** Human-readable reasons entries were dropped. NEVER contains a token
   *  value — an operator pastes these into a bug report. */
  errors: string[];
}

/** Minimum secret length we will accept. Short enough not to be annoying,
 *  long enough that a token typed by hand isn't guessable in an afternoon. */
const MIN_TOKEN_LENGTH = 16;

/** Parses a token list: `name:token[:write]` entries separated by commas,
 *  whitespace, or newlines.
 *
 *  Chosen over JSON because it has to survive being pasted into a shell
 *  export, a systemd `Environment=` line, and a TOML string without escaping.
 *  Anything unparseable is DROPPED with a reason rather than silently
 *  becoming a valid credential — a malformed entry must never widen access.
 *  Capability is opt-in: only the literal third field `write` grants it. */
export function parseServeTokens(spec: string): ParsedTokens {
  const tokens: ServeToken[] = [];
  const errors: string[] = [];
  const seenNames = new Set<string>();
  const seenSecrets = new Set<string>();

  for (const rawEntry of spec.split(/[,\s]+/)) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    const parts = entry.split(":");
    if (parts.length < 2 || parts.length > 3) {
      errors.push(`ignored a token entry: expected "name:token" or "name:token:write"`);
      continue;
    }
    const [name, token, cap] = parts as [string, string, string | undefined];
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name)) {
      errors.push(
        `ignored a token entry: name must be 1-40 chars of [A-Za-z0-9._-] (got ${JSON.stringify(name)})`
      );
      continue;
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      errors.push(`ignored token "${name}": secret shorter than ${MIN_TOKEN_LENGTH} characters`);
      continue;
    }
    if (cap !== undefined && cap !== "write") {
      errors.push(`ignored token "${name}": third field must be "write" (got ${JSON.stringify(cap)})`);
      continue;
    }
    if (seenNames.has(name)) {
      errors.push(`ignored a duplicate token name: "${name}"`);
      continue;
    }
    if (seenSecrets.has(token)) {
      errors.push(`ignored token "${name}": its secret is already used by another name`);
      continue;
    }
    seenNames.add(name);
    seenSecrets.add(token);
    tokens.push({ name, token, write: cap === "write" });
  }
  return { tokens, errors };
}

export interface LoadedTokens extends ParsedTokens {
  /** Where the accepted entries came from, for the startup banner. */
  source: "env" | "config" | "none";
}

/** Resolves the token list for `serve`: `REPOSKEIN_SERVE_TOKENS` wins over
 *  `[serve] tokens` in `.reposkein/config.toml`.
 *
 *  Env-over-config because the config file is COMMITTED — an operator who
 *  puts real secrets there has leaked them to everyone with repo access, so
 *  the documented path is the env var and config is the convenience for a
 *  private deployment. Only one source is consulted (no union): merging them
 *  would make "why does this old token still work?" unanswerable. */
export function loadServeTokens(
  repoPath: string,
  env: NodeJS.ProcessEnv = process.env
): LoadedTokens {
  const fromEnv = env.REPOSKEIN_SERVE_TOKENS?.trim();
  if (fromEnv) return { ...parseServeTokens(fromEnv), source: "env" };
  const fromConfig = readConfigString(repoPath, "serve", "tokens");
  if (fromConfig && fromConfig.trim()) {
    return { ...parseServeTokens(fromConfig), source: "config" };
  }
  return { tokens: [], errors: [], source: "none" };
}

/** Extracts the credential from an `Authorization: Bearer <token>` header.
 *  Returns null for a missing, non-Bearer, or empty-value header. */
export function bearerFromAuthHeader(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const m = /^Bearer[ \t]+(.+)$/i.exec(value.trim());
  if (!m) return null;
  const token = m[1]!.trim();
  return token === "" ? null : token;
}

/** Length-independent constant-time comparison: both sides are hashed to a
 *  fixed 32 bytes first, so `timingSafeEqual` never sees mismatched lengths
 *  (it throws on those, and the throw itself would leak the length). */
function secretEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Finds the token a presented credential matches, or null.
 *
 *  Scans the WHOLE list with no early exit so the response time doesn't
 *  reveal which position matched (or how many tokens the operator
 *  configured). */
export function matchServeToken(tokens: readonly ServeToken[], presented: string | null): ServeToken | null {
  if (presented === null) return null;
  let hit: ServeToken | null = null;
  for (const t of tokens) {
    if (secretEquals(t.token, presented)) hit = t;
  }
  return hit;
}
