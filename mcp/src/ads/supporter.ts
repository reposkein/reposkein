/** Supporter check — the "you already paid, you see no ads" gate.
 *
 *  A deliberate stub with the final signature, wired into the gating chain
 *  NOW so the sponsorship path can never ship without it: REP-29 (Ko-fi /
 *  supporter verification) replaces the body, and nothing else has to change.
 *  Until then every caller is treated as a non-supporter — which is correct,
 *  because there is no verification mechanism to be a supporter under yet.
 *
 *  Synchronous by contract: this runs inside a tool call's gating chain, so it
 *  must never do I/O on the hot path. REP-29 should resolve supporter state
 *  out of band (a cached local entitlement file, refreshed elsewhere) rather
 *  than making this async. */
export function isSupporter(): boolean {
  return false;
}
