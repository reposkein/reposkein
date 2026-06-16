/** Guided cinematic tour — pure & deterministic stop derivation.
 *
 *  `buildTour(model)` computes an ordered list of TOUR STOPS from graph stats
 *  alone (NOT hardcoded), so the tour is meaningful on any repo:
 *
 *    1. Overview            — frame-all (the whole constellation).
 *    2. Largest modules     — the top top-level clusters by descendant count.
 *    3. Busiest hub         — the node with the highest total (in+out) degree.
 *    4. Type hierarchy      — the Class/Interface with the most incident
 *                             INHERITS/IMPLEMENTS edges.
 *    5. Entry point         — a high out-degree Function (a likely driver).
 *
 *  Every metric is sorted DESC with a deterministic id tie-break, so the same
 *  graph always yields the same stops in the same order. Captions are derived
 *  from the same stats. The UI/animation layer (TourController) consumes these
 *  stops and reuses the EXISTING expand-ancestors + select + fit/fly +
 *  neighborhood-focus mechanisms — this module never touches the camera.
 *
 *  Works in static-export mode too: it only reads the already-built ClientModel.
 */

import type { ClientModel } from "./clientModel";
import type { ClusterNode } from "./cluster";

/** What the tour does when it arrives at a stop. The controller maps these to
 *  the store's existing actions; this module only DESCRIBES the intent. */
export type TourAction =
  | { kind: "overview" }
  | { kind: "expand"; clusterKey: string }
  | { kind: "focus"; nodeId: string }
  | { kind: "select"; nodeId: string };

export interface TourStop {
  /** Stable id for React keys / progress. */
  id: string;
  /** The thing to fly to: a cluster key OR a node id (resolved by the camera). */
  targetKey: string;
  captionTitle: string;
  captionBody: string;
  action: TourAction;
}

const TYPE_EDGE_TYPES = new Set(["INHERITS", "IMPLEMENTS"]);

/** Number of "largest module" stops to include (top-N top-level clusters). */
const MAX_MODULE_STOPS = 3;

/** Count direct + transitive descendants of a cluster (files + symbols + dirs),
 *  excluding the cluster itself. Memoized over the byKey tree. Deterministic. */
function descendantCounts(model: ClientModel): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (key: string): number => {
    const cached = counts.get(key);
    if (cached !== undefined) return cached;
    const c = model.byKey.get(key);
    if (!c || c.children.length === 0) {
      counts.set(key, 0);
      return 0;
    }
    let total = 0;
    for (const child of c.children) total += 1 + visit(child);
    counts.set(key, total);
    return total;
  };
  for (const key of model.byKey.keys()) visit(key);
  return counts;
}

/** Count File-kind descendants and symbol descendants of a cluster, for the
 *  module caption ("X files, Y symbols"). Deterministic tree walk. */
function fileSymbolCounts(model: ClientModel, key: string): { files: number; symbols: number } {
  let files = 0;
  let symbols = 0;
  const visit = (k: string): void => {
    const c = model.byKey.get(k);
    if (!c) return;
    if (c.kind === "file") files++;
    else if (c.kind === "symbol") symbols++;
    for (const child of c.children) visit(child);
  };
  const root = model.byKey.get(key);
  if (root) for (const child of root.children) visit(child);
  return { files, symbols };
}

/** Stable DESC-by-metric, tie-break ASC-by-id sort. */
function rankDesc<T>(items: T[], metric: (t: T) => number, id: (t: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ma = metric(a);
    const mb = metric(b);
    if (ma !== mb) return mb - ma;
    const ia = id(a);
    const ib = id(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/** Top-level clusters: the direct children of the root galaxy that actually
 *  contain something (a single "." root dir is unwrapped to ITS children so we
 *  surface real modules, not the one synthetic root directory). */
function topLevelModules(model: ClientModel): ClusterNode[] {
  const root = model.byKey.get(model.rootKey);
  if (!root) return [];
  let childKeys = root.children;
  // Unwrap a lone root directory ("dir:<repo>:.") so the "modules" are the real
  // top-level dirs/files rather than the single synthetic container.
  if (childKeys.length === 1) {
    const only = model.byKey.get(childKeys[0]!);
    if (only && only.kind === "dir" && only.children.length > 0) {
      childKeys = only.children;
    }
  }
  const out: ClusterNode[] = [];
  for (const k of childKeys) {
    const c = model.byKey.get(k);
    if (c && c.children.length > 0) out.push(c);
  }
  return out;
}

/** In- and out-degree (relationship edges only) per node id. Deterministic. */
function degrees(model: ClientModel): Map<string, { in: number; out: number }> {
  const deg = new Map<string, { in: number; out: number }>();
  const bump = (id: string, dir: "in" | "out") => {
    let d = deg.get(id);
    if (!d) {
      d = { in: 0, out: 0 };
      deg.set(id, d);
    }
    d[dir]++;
  };
  for (const e of model.drawEdges) {
    bump(e.from, "out");
    bump(e.to, "in");
  }
  return deg;
}

function displayName(model: ClientModel, nodeId: string): string {
  return model.records.get(nodeId)?.name || nodeId;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Build the deterministic tour-stop list for a graph. Caps at ~6-9 stops. */
export function buildTour(model: ClientModel): TourStop[] {
  const stops: TourStop[] = [];

  // 1) Overview ----------------------------------------------------------------
  const moduleCount = topLevelModules(model).length;
  stops.push({
    id: "overview",
    targetKey: model.rootKey,
    captionTitle: model.repoId,
    captionBody: `${plural(model.counts.nodes, "node")} · ${plural(
      model.counts.edges,
      "edge",
    )} · ${plural(moduleCount, "module")}`,
    action: { kind: "overview" },
  });

  // 2) Largest modules ---------------------------------------------------------
  const descCounts = descendantCounts(model);
  const modules = rankDesc(
    topLevelModules(model),
    (c) => descCounts.get(c.key) ?? 0,
    (c) => c.key,
  ).slice(0, MAX_MODULE_STOPS);
  for (const m of modules) {
    const { files, symbols } = fileSymbolCounts(model, m.key);
    stops.push({
      id: `module:${m.key}`,
      targetKey: m.key,
      captionTitle: m.name,
      captionBody: `${plural(files, "file")}, ${plural(symbols, "symbol")}`,
      action: { kind: "expand", clusterKey: m.key },
    });
  }

  // 3) Busiest hub -------------------------------------------------------------
  const deg = degrees(model);
  const hubCandidates = [...deg.entries()].map(([id, d]) => ({ id, total: d.in + d.out, in: d.in }));
  const hubs = rankDesc(
    hubCandidates,
    (c) => c.total,
    (c) => c.id,
  );
  const hub = hubs[0];
  if (hub && hub.total > 0) {
    stops.push({
      id: `hub:${hub.id}`,
      targetKey: hub.id,
      captionTitle: displayName(model, hub.id),
      captionBody: `called from ${plural(hub.in, "place")}`,
      action: { kind: "focus", nodeId: hub.id },
    });
  }

  // 4) Type hierarchy ----------------------------------------------------------
  // The Class/Interface with the most incident INHERITS/IMPLEMENTS edges.
  const typeIncidence = new Map<string, number>();
  for (const e of model.drawEdges) {
    if (!TYPE_EDGE_TYPES.has(e.type)) continue;
    typeIncidence.set(e.from, (typeIncidence.get(e.from) ?? 0) + 1);
    typeIncidence.set(e.to, (typeIncidence.get(e.to) ?? 0) + 1);
  }
  const typeCandidates = [...typeIncidence.entries()]
    .filter(([id]) => {
      const kind = model.records.get(id)?.kind;
      return kind === "Class" || kind === "Interface";
    })
    .map(([id, count]) => ({ id, count }));
  const typeTop = rankDesc(
    typeCandidates,
    (c) => c.count,
    (c) => c.id,
  )[0];
  if (typeTop && typeTop.count > 0) {
    const kind = model.records.get(typeTop.id)?.kind ?? "Type";
    stops.push({
      id: `type:${typeTop.id}`,
      targetKey: typeTop.id,
      captionTitle: displayName(model, typeTop.id),
      captionBody: `${kind} · ${plural(typeTop.count, "type link")}`,
      action: { kind: "focus", nodeId: typeTop.id },
    });
  }

  // 5) Entry point -------------------------------------------------------------
  // A high out-degree Function — a likely driver/orchestrator. Skip if it's the
  // same node already featured as the busiest hub (avoid a duplicate stop).
  const fnCandidates = [...deg.entries()]
    .filter(([id]) => model.records.get(id)?.kind === "Function" && id !== hub?.id)
    .map(([id, d]) => ({ id, out: d.out }));
  const entry = rankDesc(
    fnCandidates,
    (c) => c.out,
    (c) => c.id,
  )[0];
  if (entry && entry.out > 0) {
    stops.push({
      id: `entry:${entry.id}`,
      targetKey: entry.id,
      captionTitle: displayName(model, entry.id),
      captionBody: `calls out to ${plural(entry.out, "place")}`,
      action: { kind: "select", nodeId: entry.id },
    });
  }

  return stops;
}
