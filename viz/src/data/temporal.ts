/** Temporal-coupling overlay data (best-effort, additive).
 *
 *  The `/api/temporal` endpoint returns a git-derived file co-change map
 *  ({} when git/temporal is unavailable). This module fetches it and provides
 *  a pure helper that rolls each co-change pair up to the currently-visible
 *  FILE-level cluster representatives, producing dedup'd undirected links.
 *
 *  This is SEPARATE from the deterministic structural graph — it never feeds
 *  the LOD tree or the structural edges; it only drives an optional overlay.
 */

import type { ClientModel } from "./clientModel";
import { representativeFor } from "./clientModel";

/** Server shape: file path -> co-changed files with support/confidence. */
export type CochangeMap = Record<
  string,
  { path: string; support: number; confidence: number }[]
>;

export interface CouplingLink {
  /** Visible cluster representative keys (sorted so a==b is impossible after
   *  dedup; aKey < bKey). */
  aKey: string;
  bKey: string;
  support: number;
  confidence: number;
}

/** Fetch the co-change map from the view server. Best-effort: any failure
 *  yields an empty map so the overlay degrades to "no temporal data". */
export async function fetchTemporal(): Promise<CochangeMap> {
  try {
    const res = await fetch("/api/temporal");
    if (!res.ok) return {};
    return (await res.json()) as CochangeMap;
  } catch {
    return {};
  }
}

/** The file-cluster key for a repo + path, matching cluster.ts's fileKey(). */
function fileKey(repoId: string, path: string): string {
  return `file:${repoId}:${path}`;
}

/** Build dedup'd undirected coupling links between currently-visible cluster
 *  representatives. A co-change pair (a,b) maps each endpoint's FILE cluster to
 *  its deepest visible representative (so links roll up like structural edges).
 *  Self-links (same representative) are dropped. Pure & deterministic. */
export function buildCouplingLinks(
  model: ClientModel,
  cochange: CochangeMap,
  visible: Set<string>
): CouplingLink[] {
  const byPair = new Map<string, CouplingLink>();

  // Resolve a temporal file path to its deepest visible cluster representative.
  const repForPath = (path: string): string | null => {
    const fkey = fileKey(model.repoId, path);
    const c = model.byKey.get(fkey);
    if (!c) return null;
    // The file cluster's backing node id (if any) maps through representativeFor;
    // fall back to the cluster key itself.
    const nodeId = c.nodeId ?? fkey;
    return representativeFor(model, nodeId, visible) ?? (visible.has(fkey) ? fkey : null);
  };

  for (const [src, partners] of Object.entries(cochange)) {
    const srcRep = repForPath(src);
    if (!srcRep) continue;
    for (const { path, support, confidence } of partners) {
      const dstRep = repForPath(path);
      if (!dstRep || dstRep === srcRep) continue;
      const [aKey, bKey] = srcRep < dstRep ? [srcRep, dstRep] : [dstRep, srcRep];
      const pairKey = `${aKey} ${bKey}`;
      const existing = byPair.get(pairKey);
      // Keep the strongest (max support, then max confidence) — the server
      // emits the pair from both directions; we collapse to one link.
      if (
        !existing ||
        support > existing.support ||
        (support === existing.support && confidence > existing.confidence)
      ) {
        byPair.set(pairKey, { aKey, bKey, support, confidence });
      }
    }
  }

  return [...byPair.values()].sort((x, y) =>
    x.aKey === y.aKey ? (x.bKey < y.bKey ? -1 : 1) : x.aKey < y.aKey ? -1 : 1
  );
}
