/** Supporter check — the "you already paid, you see no ads" gate.
 *
 *  REP-28 wired a stub of this into `resolveAdsVerdict` so the sponsorship
 *  path could never ship without it. REP-29 filled it in. The signature is
 *  unchanged: still synchronous, still consulted before any slot is
 *  requested, still returning a plain boolean.
 *
 *  ## Entirely local
 *
 *  Verification is a signature check against a public key compiled into this
 *  package (`supporterKey.ts`) over a file the user placed at
 *  `~/.config/reposkein/supporter.jwt`. There is no licence server, no
 *  activation, no revocation fetch, no telemetry — and the import graph
 *  reachable from this module contains nothing that can open a socket, which
 *  a test asserts statically rather than trusting this comment. Being a
 *  supporter is therefore something you can be on a plane, behind a
 *  corporate proxy, or on a machine that has never resolved DNS.
 *
 *  ## Staying off the hot path
 *
 *  This runs inside a tool call's gating chain, so the expensive parts are
 *  cached for the process:
 *
 *  - The signature verification result is cached against the entitlement
 *    file's (mtime, size). Editing or replacing the file invalidates it.
 *  - The `statSync` that detects such an edit is THROTTLED: at most one every
 *    `RECHECK_INTERVAL_MS`. Between probes the cached claims are reused, so a
 *    steady stream of tool calls costs one integer comparison each, not one
 *    syscall each.
 *  - Expiry is re-evaluated on every call regardless, since it depends on the
 *    clock rather than on the file. A token that lapses mid-session stops
 *    entitling immediately, without waiting for a stat.
 *
 *  The bound this buys: a token added, renewed, or deleted mid-session takes
 *  effect within `RECHECK_INTERVAL_MS` (five seconds) rather than instantly.
 *  For a gate whose only job is to suppress an ad, that is the right trade. */

import {
  classifyClaims,
  isEntitled,
  verifySupporterTokenClaims,
  type SupporterClaims,
  type SupporterRejection,
  type SupporterVerdict,
} from "./supporterToken.js";
import { readSupporterTokenFile, statSupporterTokenFile, supporterTokenPath } from "./supporterStore.js";

/** How often the entitlement file may be re-probed on the hot path. */
export const RECHECK_INTERVAL_MS = 5_000;

/** What `support --status` (and `doctor`, later) needs to say something
 *  useful. `state: "none"` means no entitlement file at all — the state of
 *  every install that has not run `reposkein-mcp support`. */
export type SupporterStatus =
  | { state: "none"; path: string }
  | { state: "valid" | "grace" | "expired"; path: string; claims: SupporterClaims; mode: number | null }
  | { state: "invalid"; path: string; reason: SupporterRejection; mode: number | null };

interface CacheEntry {
  /** Identity of the file the cached decision was derived from. */
  mtimeMs: number;
  size: number;
  path: string;
  /** Verified claims, or null when the file's contents were unusable. */
  claims: SupporterClaims | null;
  reason: SupporterRejection | null;
  /** Wall-clock of the last `statSync`, for throttling. */
  probedAt: number;
}

/** Module-level and deliberately so: the entitlement is a property of the
 *  machine, not of a server connection, and re-verifying an Ed25519 signature
 *  per connection would be pure waste. Reset in tests via
 *  `resetSupporterCache()`. */
let cache: CacheEntry | null = null;

/** Drops the memoized verification. Tests call it; nothing in production
 *  does — the mtime/size probe is what keeps the cache honest at runtime. */
export function resetSupporterCache(): void {
  cache = null;
}

/** Reads + verifies with no caching and no clock-independent shortcuts. The
 *  CLI path: correctness and detail matter, a syscall does not. */
export function readSupporterStatus(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): SupporterStatus {
  const path = supporterTokenPath(env);
  const st = statSupporterTokenFile(env);
  if (!st) return { state: "none", path };
  const text = readSupporterTokenFile(env);
  if (text === null) return { state: "invalid", path, reason: "empty", mode: st.mode };
  const parsed = verifySupporterTokenClaims(text);
  if (!parsed.ok) return { state: "invalid", path, reason: parsed.reason, mode: st.mode };
  const verdict = classifyClaims(parsed.claims, now);
  if (verdict.state === "invalid") return { state: "invalid", path, reason: verdict.reason, mode: st.mode };
  return { state: verdict.state, path, claims: verdict.claims, mode: st.mode };
}

/** The cached verdict used by the gating chain. Exported for tests and for
 *  anything that wants the reason as well as the boolean. */
export function supporterVerdict(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): SupporterVerdict {
  const path = supporterTokenPath(env);

  // Reuse the cached claims without touching the filesystem while the
  // throttle window is open and the path has not changed under us.
  if (cache && cache.path === path && now - cache.probedAt < RECHECK_INTERVAL_MS) {
    return fromCache(cache, now);
  }

  const st = statSupporterTokenFile(env);
  if (!st) {
    cache = { mtimeMs: -1, size: -1, path, claims: null, reason: "empty", probedAt: now };
    return { state: "invalid", reason: "empty" };
  }

  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
    cache.probedAt = now;
    return fromCache(cache, now);
  }

  const text = readSupporterTokenFile(env);
  const parsed = text === null ? ({ ok: false, reason: "empty" } as const) : verifySupporterTokenClaims(text);
  cache = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    path,
    claims: parsed.ok ? parsed.claims : null,
    reason: parsed.ok ? null : parsed.reason,
    probedAt: now,
  };
  return fromCache(cache, now);
}

function fromCache(entry: CacheEntry, now: number): SupporterVerdict {
  if (!entry.claims) return { state: "invalid", reason: entry.reason ?? "empty" };
  return classifyClaims(entry.claims, now);
}

/** The gate itself. True only for a signed, untampered, correctly-tiered
 *  token that is inside its validity window or its grace period.
 *
 *  Fail-CLOSED with respect to entitlement (any doubt → "not a supporter",
 *  which merely means the normal, already-opt-in-gated ad path applies) and
 *  fail-OPEN with respect to errors: nothing here can throw into a tool
 *  call. */
export function isSupporter(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
  try {
    return isEntitled(supporterVerdict(env, now));
  } catch {
    return false;
  }
}
