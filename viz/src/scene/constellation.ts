/** Deterministic "star-sign" connector derivation for the constellation lines
 *  decoration. Pure & deterministic (NO randomness): given a fixed list of
 *  member points it returns a minimum spanning tree as index pairs, computed
 *  with Prim's algorithm and deterministic tie-breaking (lowest index wins).
 *
 *  These connectors are decorative only — they reinforce the astronomy
 *  metaphor inside an expanded cluster and are visually distinct from the real
 *  typed edges. They never touch the layout or the committed data. */

export interface ConstellationPoint {
  /** Stable identity (only used for deterministic ordering / not geometry). */
  key: string;
  x: number;
  y: number;
  z: number;
}

function dist2(a: ConstellationPoint, b: ConstellationPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Minimum spanning tree over `points` (Prim's, dense O(n²)). Returns the tree
 *  edges as [i, j] index pairs into `points`. Deterministic: starts from index
 *  0, and ties on distance are broken by the lower candidate index, so the same
 *  input always yields the same tree. Returns [] for fewer than 2 points. */
export function constellationMst(points: ConstellationPoint[]): [number, number][] {
  const n = points.length;
  if (n < 2) return [];

  const inTree = new Array<boolean>(n).fill(false);
  // best[i] = squared distance from i to the current tree; parent[i] = the
  // in-tree node achieving it.
  const best = new Array<number>(n).fill(Infinity);
  const parent = new Array<number>(n).fill(-1);

  inTree[0] = true;
  for (let j = 1; j < n; j++) {
    best[j] = dist2(points[0]!, points[j]!);
    parent[j] = 0;
  }

  const edges: [number, number][] = [];
  for (let added = 1; added < n; added++) {
    // Pick the not-yet-added node closest to the tree (lowest index on ties).
    let u = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (inTree[i]) continue;
      if (best[i]! < bestD) {
        bestD = best[i]!;
        u = i;
      }
    }
    if (u === -1) break; // disconnected guard (shouldn't happen for finite pts)
    inTree[u] = true;
    const p = parent[u]!;
    // Emit with the lower index first for a canonical pair ordering.
    edges.push(p < u ? [p, u] : [u, p]);

    // Relax the frontier with the newly added node.
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = dist2(points[u]!, points[v]!);
      if (d < best[v]!) {
        best[v] = d;
        parent[v] = u;
      }
    }
  }

  // Canonical, deterministic emission order (independent of insertion order).
  edges.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  return edges;
}
