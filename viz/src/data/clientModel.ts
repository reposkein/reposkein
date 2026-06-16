/** Main-thread view of the worker result: rebuilds lookup Maps and computes
 *  visibility for the current expansion state. Pure helpers (no React). */

import type { ClusterNode } from "./cluster";
import type { DrawEdge, NodeRecord } from "./model";
import type { WorkerResult } from "./worker/graph.worker";

export interface ClientModel {
  repoId: string;
  rootKey: string;
  byKey: Map<string, ClusterNode>;
  keys: string[];
  positions: Float32Array;
  indexByKey: Map<string, number>;
  drawEdges: DrawEdge[];
  records: Map<string, NodeRecord>;
  fingerprint: string;
  counts: { nodes: number; edges: number };
  /** node id -> the deepest cluster key on its ancestor chain (itself for symbols). */
  clusterOfNode: Map<string, string>;
  /** ancestor chain (root→...→self) per cluster key. */
  ancestors: Map<string, string[]>;
}

export function fromWorker(r: WorkerResult): ClientModel {
  const byKey = new Map<string, ClusterNode>();
  for (const c of r.clusters) byKey.set(c.key, c);

  const indexByKey = new Map<string, number>();
  r.keys.forEach((k, i) => indexByKey.set(k, i));

  const records = new Map(r.records);

  // node id -> cluster key. Symbols' cluster key IS their node id; files/dirs
  // carry a nodeId we map to their key.
  const clusterOfNode = new Map<string, string>();
  for (const c of byKey.values()) {
    if (c.nodeId) clusterOfNode.set(c.nodeId, c.key);
  }

  // Ancestor chains (root → self).
  const ancestors = new Map<string, string[]>();
  const chainOf = (key: string): string[] => {
    const cached = ancestors.get(key);
    if (cached) return cached;
    const c = byKey.get(key);
    if (!c) return [key];
    const chain = c.parent ? [...chainOf(c.parent), key] : [key];
    ancestors.set(key, chain);
    return chain;
  };
  for (const key of byKey.keys()) chainOf(key);

  return {
    repoId: r.repoId,
    rootKey: r.rootKey,
    byKey,
    keys: r.keys,
    positions: r.positions,
    indexByKey,
    drawEdges: r.drawEdges,
    records,
    fingerprint: r.fingerprint,
    counts: r.counts,
    clusterOfNode,
    ancestors,
  };
}

/** Given the set of expanded cluster keys, returns the set of cluster keys
 *  that should currently be RENDERED (the deepest visible representative on
 *  each branch). A cluster is visible if all its ancestors are expanded; we
 *  render a node when it's visible and either a leaf (symbol) or NOT itself
 *  expanded (collapsed clusters render as a single glow). */
export function visibleClusters(model: ClientModel, expanded: Set<string>): Set<string> {
  const out = new Set<string>();
  const visit = (key: string): void => {
    const c = model.byKey.get(key);
    if (!c) return;
    const isExpanded = expanded.has(key);
    if (c.children.length === 0 || !isExpanded) {
      out.add(key); // render this representative
      return;
    }
    for (const child of c.children) visit(child);
  };
  visit(model.rootKey);
  return out;
}

/** Maps a node id to the deepest currently-visible cluster representative on
 *  its ancestor chain (for edge roll-up). */
export function representativeFor(
  model: ClientModel,
  nodeId: string,
  visible: Set<string>
): string | null {
  const clusterKey = model.clusterOfNode.get(nodeId) ?? nodeId;
  const chain = model.ancestors.get(clusterKey);
  if (!chain) return visible.has(clusterKey) ? clusterKey : null;
  // Deepest ancestor that is visible.
  for (let i = chain.length - 1; i >= 0; i--) {
    const k = chain[i]!;
    if (visible.has(k)) return k;
  }
  return null;
}
