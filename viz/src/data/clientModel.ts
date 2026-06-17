/** Main-thread view of the worker result: rebuilds lookup Maps and computes
 *  visibility for the current expansion state. Pure helpers (no React). */

import type { ClusterNode } from "./cluster";
import type { DrawEdge, NodeRecord } from "./model";
import type { WorkerResult } from "./worker/graph.worker";

export interface ClientModel {
  repoId: string;
  /** Absolute path of the served repo root, or null (for editor links). */
  repoRoot: string | null;
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
  /** Bounding-box diagonal of the seeded layout (deterministic). Drives the
   *  edge length-attenuation thresholds so falloff scales with the scene. */
  sceneDiag: number;
  /** node id -> the deepest 'file' ancestor cluster key, or absent. Built once
   *  from the (sorted) tree so the LOD roll-up's fileOf is O(1) over edges. */
  fileByNode: Map<string, string>;
  /** node id -> the set of node ids it shares a relationship edge with (BOTH
   *  directions). Built ONCE per model so the hover 1-hop highlight is O(degree)
   *  instead of an O(all-edges) scan per pointer-move. */
  neighborsByNode: Map<string, Set<string>>;
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

  // Scene-bounding diagonal from the seeded positions (deterministic). Drives
  // the edge length-attenuation thresholds. `|| 1` guards a degenerate scene.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < r.positions.length; i += 3) {
    const x = r.positions[i]!, y = r.positions[i + 1]!, z = r.positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const sceneDiag =
    r.positions.length === 0 ? 1 : Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;

  // node id -> deepest 'file' ancestor cluster key (for the LOD roll-up clamp).
  // Built once from the sorted tree (ancestor chains are root→self); O(nodes).
  const fileByNode = new Map<string, string>();
  for (const [nodeId, clusterKey] of clusterOfNode) {
    const chain = ancestors.get(clusterKey);
    if (!chain) continue;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (byKey.get(chain[i]!)?.kind === "file") {
        fileByNode.set(nodeId, chain[i]!);
        break;
      }
    }
  }

  // node id -> set of relationship-edge neighbors (both directions). Built once
  // here so the hover 1-hop highlight never re-scans the full edge list.
  const neighborsByNode = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = neighborsByNode.get(a);
    if (!s) {
      s = new Set<string>();
      neighborsByNode.set(a, s);
    }
    s.add(b);
  };
  for (const e of r.drawEdges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }

  return {
    repoId: r.repoId,
    repoRoot: r.repoRoot,
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
    sceneDiag,
    fileByNode,
    neighborsByNode,
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

/** Deepest visible cluster representative of a node id (alias of
 *  `representativeFor`, named to read at the call sites that walk a single id).
 *  Single source of truth shared by EdgeLines / StarField / FlowParticles. */
export function repOf(
  model: ClientModel,
  nodeId: string,
  visible: Set<string>,
): string | null {
  return representativeFor(model, nodeId, visible);
}

/** Convenience alias for the hovered node's visible representative. */
export function hoveredRepOf(
  model: ClientModel,
  hoveredId: string,
  visible: Set<string>,
): string | null {
  return representativeFor(model, hoveredId, visible);
}

/** Rolls a neighborhood-focus result up to the set of currently-visible cluster
 *  representatives (the focused region's reps). Returns null when there is no
 *  focus. Shared so EdgeLines / StarField / FlowParticles agree on the set. */
export function focusRepsOf(
  model: ClientModel,
  focus: { nodes: Iterable<string> } | null,
  visible: Set<string>,
): Set<string> | null {
  if (!focus) return null;
  const set = new Set<string>();
  for (const id of focus.nodes) {
    const r = representativeFor(model, id, visible);
    if (r) set.add(r);
  }
  return set;
}

/** Deepest 'file' ancestor cluster key of a node id, or null. O(1) via the
 *  precomputed `fileByNode` map. */
export function fileOf(model: ClientModel, nodeId: string): string | null {
  return model.fileByNode.get(nodeId) ?? null;
}

/** Visible cluster representatives that should stay BRIGHT while hovering a
 *  node: the hovered node's own rep + the reps of its 1-hop relationship
 *  neighbors. O(degree) via the precomputed `neighborsByNode` adjacency (NOT a
 *  per-hover scan over all edges). Returns null when nothing is hovered. */
export function hoverHighlightReps(
  model: ClientModel,
  hoveredId: string | null,
  visible: Set<string>,
): Set<string> | null {
  if (!hoveredId) return null;
  const set = new Set<string>();
  const self = representativeFor(model, hoveredId, visible);
  if (self) set.add(self);
  const neighbors = model.neighborsByNode.get(hoveredId);
  if (neighbors) {
    for (const nid of neighbors) {
      const r = representativeFor(model, nid, visible);
      if (r) set.add(r);
    }
  }
  return set;
}

// --- Shared expand-reveal helpers ------------------------------------------
// The "open every expandable cluster on a node's ancestor chain so the node
// surfaces as a visible representative" walk was duplicated across the store
// reducer (expandToReveal), TourController.revealAncestors, Root's keyboard-nav
// + URL-node effects, and Breadcrumb.navigateToCrumb. These pure helpers are
// the single source of truth: they return the cluster keys that should be
// EXPANDED, and callers decide how to apply them (a fresh Set for the reducer,
// or a sequence of toggleExpand dispatches for the imperative UI walks).

/** The cluster keys on a node id's ancestor chain that are expandable
 *  (children.length > 0), in root→self order. Walks `clusterOfNode` →
 *  `ancestors` once; returns [] for an unknown node. Pure. */
export function revealChainFor(model: ClientModel, nodeId: string): string[] {
  const clusterKey = model.clusterOfNode.get(nodeId) ?? nodeId;
  const chain = model.ancestors.get(clusterKey);
  if (!chain) return [];
  const out: string[] = [];
  for (const ak of chain) {
    const c = model.byKey.get(ak);
    if (c && c.children.length > 0) out.push(ak);
  }
  return out;
}

/** Returns a NEW expanded set with every expandable ancestor cluster of each
 *  node in `nodeIds` opened, so the highlighted members surface as visible
 *  reps. The pure form used by the store reducer (impact / focus overlays). */
export function expandToReveal(
  model: ClientModel,
  expanded: Set<string>,
  nodeIds: Iterable<string>,
): Set<string> {
  const next = new Set(expanded);
  for (const id of nodeIds) {
    for (const ak of revealChainFor(model, id)) next.add(ak);
  }
  return next;
}

/** One rolled-up connection between two currently-visible cluster
 *  representatives (design §3.2). Aggregates every raw relationship edge that
 *  maps to the same `(srcKey, dstKey)` pair so cluster↔cluster bundles render
 *  at EVERY LOD — including the top level (galaxy/dir cores). */
export interface EdgeBundle {
  srcKey: string;
  dstKey: string;
  /** number of raw edges in the bundle. */
  count: number;
  /** dominant raw edge type (most frequent), drives the bundle hue. */
  dominantType: string;
  /** strongest resolution among members, drives the bundle brightness. */
  bestResolution: "exact" | "name_match" | "ambiguous";
  /** the set of node ids on each side (for hover incidence highlighting). */
  srcNodes: Set<string>;
  dstNodes: Set<string>;
}

/** The edge-visibility filter inputs shared by the structural edge buffers
 *  (EdgeLines) and the flow-particle buffer (FlowParticles), so both honor the
 *  exact same edge-type / confidence / audit gating. */
export interface EdgeFilterState {
  edgeTypes: Set<string>;
  minConfidence: number;
  /** "off" | "ambiguous" | "ambiguous+name" — confidence-audit override. */
  audit: string;
}

/** Returns `model` with `drawEdges` filtered by the audit/type/confidence
 *  rules (identical to EdgeLines' own gate). Returns the SAME model object when
 *  no filter is active (no allocation). Pure. */
export function filterDrawEdges<M extends { drawEdges: DrawEdge[] }>(
  model: M,
  filters: EdgeFilterState,
): M {
  const auditResolutions =
    filters.audit === "ambiguous"
      ? new Set(["ambiguous"])
      : filters.audit === "ambiguous+name"
      ? new Set(["ambiguous", "name_match"])
      : null;
  const needsFilter =
    auditResolutions !== null || filters.edgeTypes.size > 0 || filters.minConfidence > 0;
  if (!needsFilter) return model;
  return {
    ...model,
    drawEdges: model.drawEdges.filter((e) => {
      if (auditResolutions) return auditResolutions.has(e.resolution);
      return (
        (filters.edgeTypes.size === 0 || !filters.edgeTypes.has(e.type)) &&
        e.confidence >= filters.minConfidence
      );
    }),
  };
}

/** Resolution strength ranks (exact > name_match > ambiguous): picks a
 *  bundle's strongest member resolution during roll-up. */
const RES_RANK: Record<string, number> = { exact: 3, name_match: 2, ambiguous: 1 };

// --- Unified edge selection + LOD roll-up (design §1.1) --------------------

const SYMBOL_KIND = "symbol";

/** Hard cap on the number of bundles fed to the renderer. The LOD clamp bounds
 *  the default view, but a high-fanout hub core can still emit thousands of
 *  bundles; we keep the top-N by count and report the PRE-cap total so the HUD
 *  "showing N of M" stays honest. Chosen so drawn·EDGE_K_MIN can't exceed the
 *  ink ceiling (see encoding.adaptiveEdgeScale). */
export const MAX_BUNDLES = 2500;

/** A bundle plus the length-driven opacity falloff applied at the style stage. */
export interface LodBundle extends EdgeBundle {
  lengthAtten: number;
}

export interface SelectEdgeOpts {
  /** Currently-expanded cluster keys. */
  expanded: Set<string>;
  /** Edge type / confidence / audit gating. */
  filters: EdgeFilterState;
  /** selected ∪ hovered ∪ focus.nodes — their files render at symbol granularity. */
  activeNodes: Iterable<string>;
}

/** Deepest visible rep, CLAMPED up to the file core when the rep is a symbol
 *  whose file is NOT in the active set. This is the hairball fix: with nothing
 *  active, every symbol↔symbol edge collapses to file↔file. */
function lodRepresentativeFor(
  model: ClientModel,
  nodeId: string,
  visible: Set<string>,
  activeFiles: Set<string>,
): string | null {
  const rep = representativeFor(model, nodeId, visible);
  if (!rep) return null;
  if (model.byKey.get(rep)?.kind !== SYMBOL_KIND) return rep; // file/dir/galaxy core
  const f = fileOf(model, nodeId);
  if (f && activeFiles.has(f)) return rep; // active region → keep symbol granularity
  if (f && visible.has(f)) return f; // else clamp up to file core
  return rep; // fallback: file not visible, keep symbol
}

/** The unified deterministic edge-selection pass (design §1.1) — the SINGLE
 *  edge roll-up. Rolls raw edges up to their visible cluster reps and aggregates
 *  into per-pair bundles, adding the symbol→file LOD clamp + length attenuation
 *  + a hard bundle cap. Pure & byte-stable given identical inputs.
 *
 *  Returns `drawn` bundles (post-cap, sorted) and `total` (PRE-cap count) so the
 *  HUD can show "N of M". */
export function selectVisibleEdges(
  model: ClientModel,
  o: SelectEdgeOpts,
): { bundles: LodBundle[]; visible: Set<string>; activeFiles: Set<string>; total: number } {
  const visible = visibleClusters(model, o.expanded);
  const fm = filterDrawEdges(model, o.filters);

  // Active files: files of selected/hovered/focus nodes + any explicitly-expanded file.
  const activeFiles = new Set<string>();
  for (const id of o.activeNodes) {
    const f = fileOf(model, id);
    if (f) activeFiles.add(f);
  }
  for (const k of o.expanded) {
    if (model.byKey.get(k)?.kind === "file") activeFiles.add(k);
  }

  // Roll up with the LOD clamp; aggregate exactly like bundleEdges.
  const byPair = new Map<string, LodBundle>();
  const typeCounts = new Map<string, Map<string, number>>();
  for (const e of fm.drawEdges) {
    const s = lodRepresentativeFor(model, e.from, visible, activeFiles);
    const d = lodRepresentativeFor(model, e.to, visible, activeFiles);
    if (!s || !d || s === d) continue; // self-loops dropped (de-hairball)
    const pk = `${s} ${d}`;
    let b = byPair.get(pk);
    if (!b) {
      b = {
        srcKey: s,
        dstKey: d,
        count: 0,
        dominantType: e.type,
        bestResolution: e.resolution,
        srcNodes: new Set<string>(),
        dstNodes: new Set<string>(),
        lengthAtten: 1,
      };
      byPair.set(pk, b);
      typeCounts.set(pk, new Map());
    }
    b.count++;
    b.srcNodes.add(e.from);
    b.dstNodes.add(e.to);
    if (RES_RANK[e.resolution]! > RES_RANK[b.bestResolution]!) b.bestResolution = e.resolution;
    const tc = typeCounts.get(pk)!;
    tc.set(e.type, (tc.get(e.type) ?? 0) + 1);
  }

  // dominantType resolution: identical to bundleEdges (sorted type keys, max count).
  for (const [pk, b] of byPair) {
    const tc = typeCounts.get(pk)!;
    let best = b.dominantType;
    let bestN = -1;
    for (const [t, n] of [...tc.entries()].sort((a, c) => (a[0] < c[0] ? -1 : 1))) {
      if (n > bestN) {
        bestN = n;
        best = t;
      }
    }
    b.dominantType = best;
  }

  // lengthAtten — one sqrt per bundle (post-aggregation, few hundreds).
  const L0 = 0.35 * model.sceneDiag;
  const L1 = 0.9 * model.sceneDiag;
  const MIN = 0.12;
  const P = model.positions;
  const ix = model.indexByKey;
  for (const b of byPair.values()) {
    const si = ix.get(b.srcKey);
    const di = ix.get(b.dstKey);
    if (si === undefined || di === undefined) continue;
    const dx = P[si * 3]! - P[di * 3]!;
    const dy = P[si * 3 + 1]! - P[di * 3 + 1]!;
    const dz = P[si * 3 + 2]! - P[di * 3 + 2]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    b.lengthAtten =
      len <= L0 ? 1 : len >= L1 ? MIN : 1 - (1 - MIN) * ((len - L0) / (L1 - L0));
  }

  const total = byPair.size;

  // Deterministic emission order (count desc, then srcKey, then dstKey) so the
  // hard cap keeps the most-trafficked bundles reproducibly. Sorting the SAME
  // way also stabilizes the post-cap geometry.
  const sorted = [...byPair.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count; // count desc
    if (a.srcKey !== b.srcKey) return a.srcKey < b.srcKey ? -1 : 1;
    return a.dstKey < b.dstKey ? -1 : 1;
  });
  const kept = sorted.length > MAX_BUNDLES ? sorted.slice(0, MAX_BUNDLES) : sorted;

  // Re-sort the kept set by (srcKey, dstKey) for a stable render/buffer order
  // (so beta=0 reproduces the pre-bundling straight-line render).
  kept.sort((a, b) =>
    a.srcKey === b.srcKey ? (a.dstKey < b.dstKey ? -1 : 1) : a.srcKey < b.srcKey ? -1 : 1,
  );

  return { bundles: kept, visible, activeFiles, total };
}
