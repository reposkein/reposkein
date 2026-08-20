/** Fallback resolution for an unknown `?node=<id>` deep link (design: "Host
 *  your constellation" — a shared static export outlives the commit it was
 *  baked from, so a linked node can be gone by the time someone opens the
 *  link). Pure, so it has its own unit-test surface without rendering React.
 *
 *  The one signal that survives a repo_id change (e.g. a federated child repo
 *  renamed) without a live content-hash history is the id SUFFIX: node ids
 *  are `rs1:<repoId>:<rest>`, and `<rest>` is stable across a repo_id change.
 *  This mirrors the server-side anchor "fork tolerance" resolution in
 *  mcp/src/store/decisions.ts (idSuffix / resolveAnchorStates) — the same
 *  idea, applied client-side against the currently-loaded record set. A
 *  genuine rename/delete within the SAME repo_id has no live id sharing that
 *  suffix, so it correctly falls through to null (caller shows the
 *  "node not found" notice). True content-hash rename detection is out of
 *  reach here: it needs the OLD node's content hash, which a bare URL id
 *  doesn't carry. */

/** The `<rest>` after `rs1:<repoId>`, or null if `id` doesn't match the
 *  `rs1:<repoId>:...` shape. */
function idSuffix(id: string): string | null {
  const m = id.match(/^rs1:[^:]+(:.+)$/);
  return m ? m[1]! : null;
}

/** Given an unresolved `id` and the set of ids currently in the loaded model,
 *  returns a live id sharing the same suffix (`rs1:<anyRepoId><rest>`), or
 *  null if none exists. Deterministic: picks the lexicographically smallest
 *  match so repeated calls agree. */
export function resolveNodeFallback(id: string, recordIds: Iterable<string>): string | null {
  const suffix = idSuffix(id);
  if (!suffix) return null;
  let best: string | null = null;
  for (const candidate of recordIds) {
    if (candidate === id) continue; // already known to be absent, but guard anyway
    if (!candidate.endsWith(suffix)) continue;
    if (idSuffix(candidate) !== suffix) continue; // must match at the repoId boundary, not mid-string
    if (best === null || candidate < best) best = candidate;
  }
  return best;
}
