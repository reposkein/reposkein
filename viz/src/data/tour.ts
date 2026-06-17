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
import type { LensId } from "./lens";

/** A guided-tour stop is a fully declarative, self-isolated FRAME. The
 *  controller runs one fixed apply sequence for every stop (clean slate → lens
 *  → bounded expand → focus/isolate → fit), so a stop never accumulates state
 *  from the previous one. Each field names exactly one concern:
 *
 *    - kind          which apply branch (overview / module-expand / node-focus)
 *    - targetKey     cluster key OR node id flown to (setFocusTarget resolves both)
 *    - expandKeys    explicit cluster keys to open (module key, or [])
 *    - expandDepth   HARD cap: 0 = nothing, 1 = one level (files), NEVER symbols
 *    - lens          the single lens this stop shows ("all"|"calls"|"types"|"imports")
 *    - focusNodeId   when set, arm neighborhood-focus on this node
 *    - collapsePrevious  wipe ALL prior expansion first (true for every stop)
 */
export interface TourStop {
  /** Stable id for React keys / progress. */
  id: string;
  kind: "overview" | "module" | "node";
  /** The thing to fly to: a cluster key OR a node id (resolved by the camera). */
  targetKey: string;
  /** Explicit cluster keys to open (module stops: the module key; else []). */
  expandKeys: string[];
  /** Hard cap on expansion depth: module stops open AT MOST one level (files). */
  expandDepth: 0 | 1;
  /** The single lens this stop shows. */
  lens: LensId;
  /** When set, arm neighborhood-focus on this node (node stops). */
  focusNodeId: string | null;
  /** Wipe all prior expansion + overlays before applying this stop. */
  collapsePrevious: boolean;
  caption: { title: string; body: string };
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

/** Build the deterministic tour-stop list for a graph. Caps at ~6-9 stops.
 *
 *  Every stop carries `collapsePrevious: true` so the controller wipes prior
 *  expansion before applying it — each stop is a clean, single-concern frame:
 *
 *    | Stop          | kind     | targetKey | expandKeys | depth | lens    | focusNodeId |
 *    | Overview      | overview | rootKey   | []         | 0     | all     | null        |
 *    | Top-N modules | module   | m.key     | [m.key]    | 1     | imports | null        |
 *    | Busiest hub   | node     | hub.id    | []         | 0     | calls   | hub.id      |
 *    | Type hierarchy| node     | typeTop.id| []         | 0     | types   | typeTop.id  |
 *    | Entry point   | node     | entry.id  | []         | 0     | calls   | entry.id    |
 */
export function buildTour(model: ClientModel): TourStop[] {
  const stops: TourStop[] = [];

  // 1) Overview ----------------------------------------------------------------
  const moduleCount = topLevelModules(model).length;
  stops.push({
    id: "overview",
    kind: "overview",
    targetKey: model.rootKey,
    expandKeys: [],
    expandDepth: 0,
    lens: "all",
    focusNodeId: null,
    collapsePrevious: true,
    caption: {
      title: model.repoId,
      body: `${plural(model.counts.nodes, "node")} · ${plural(
        model.counts.edges,
        "edge",
      )} · ${plural(moduleCount, "module")}`,
    },
  });

  // 2) Largest modules — open AT MOST one level (to files) under the imports
  //    lens, so only that module's blue IMPORTS arcs show (never 505 symbols).
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
      kind: "module",
      targetKey: m.key,
      expandKeys: [m.key],
      expandDepth: 1,
      lens: "imports",
      focusNodeId: null,
      collapsePrevious: true,
      caption: {
        title: m.name,
        body: `${plural(files, "file")}, ${plural(symbols, "symbol")}`,
      },
    });
  }

  // 3) Busiest hub — the highest in+out degree node, under the calls lens.
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
      kind: "node",
      targetKey: hub.id,
      expandKeys: [],
      expandDepth: 0,
      lens: "calls",
      focusNodeId: hub.id,
      collapsePrevious: true,
      caption: {
        title: displayName(model, hub.id),
        body: `called from ${plural(hub.in, "place")}`,
      },
    });
  }

  // 4) Type hierarchy — the Class/Interface with the most incident
  //    INHERITS/IMPLEMENTS edges, under the types lens.
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
      kind: "node",
      targetKey: typeTop.id,
      expandKeys: [],
      expandDepth: 0,
      lens: "types",
      focusNodeId: typeTop.id,
      collapsePrevious: true,
      caption: {
        title: displayName(model, typeTop.id),
        body: `${kind} · ${plural(typeTop.count, "type link")}`,
      },
    });
  }

  // 5) Entry point — a high out-degree Function (a likely driver) under the
  //    calls lens. Skip if it's the same node already featured as the hub.
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
      kind: "node",
      targetKey: entry.id,
      expandKeys: [],
      expandDepth: 0,
      lens: "calls",
      focusNodeId: entry.id,
      collapsePrevious: true,
      caption: {
        title: displayName(model, entry.id),
        body: `calls out to ${plural(entry.out, "place")}`,
      },
    });
  }

  return stops;
}
