import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import GraphWorker from "../data/worker/graph.worker.ts?worker";
import { fromWorker, type ClientModel } from "../data/clientModel";
import type {
  WorkerError,
  WorkerProgress,
  WorkerResult,
} from "../data/worker/graph.worker";
import { resolveLens, type Emphasis, type LensId } from "../data/lens";
import { computeImpact, type ImpactResult } from "../data/impact";
import {
  computeNeighborhood,
  DEFAULT_FOCUS_DEPTH,
  clampDepth,
  type NeighborhoodResult,
} from "../data/neighborhood";
import { ALL_EDGE_TYPES } from "../data/lens";
import type { CochangeMap } from "../data/temporal";
import { buildStaticResult, staticPayload } from "../data/staticMode";

type Status =
  | { kind: "loading"; phase: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface Filters {
  kinds: Set<string>;      // hidden symbol kinds; empty = show all
  edgeTypes: Set<string>;  // hidden edge types; empty = show all
  minConfidence: number;   // 0..1, default 0
}

interface State {
  status: Status;
  model: ClientModel | null;
  expanded: Set<string>;
  selected: string | null;
  hovered: string | null;
  /** Bumped whenever the visible set changes (load / expand / collapse) or a
   *  star is framed, so the camera-fit hook can refit to what's on screen. */
  fitNonce: number;
  filters: Filters;
  /** Node id to fly-to: set by search, consumed by Controls. Bumps fitNonce. */
  focusTarget: string | null;
  /** Active lens id (one-click filter preset). "all" = default. A manual
   *  filter edit drops the lens back to "all" so the chip never lies. */
  lens: LensId;
  /** Scene emphasis driven by the active lens (highlights a node class). */
  emphasis: Emphasis;
  /** Confidence-audit mode: show ONLY low-confidence edges. When set, the
   *  scene shows ambiguous (and optionally name_match) edges only. */
  audit: AuditMode;
  /** Impact overlay: transitive reverse-CALLS callers + covering tests of the
   *  selected node. null = inactive. */
  impact: ImpactResult | null;
  /** Temporal-coupling overlay toggle (best-effort git co-change links). */
  coupling: boolean;
  /** Fetched co-change map (null = not yet fetched; {} = fetched, no data). */
  cochange: CochangeMap | null;
  /** Neighborhood focus: the bidirectional, depth-bounded set of nodes the
   *  selected symbol touches. null = inactive. */
  focus: NeighborhoodResult | null;
  /** Focus BFS depth (1..3); the toggle/recompute reads this. */
  focusDepth: number;
}

/** Confidence-audit preset: which low-confidence buckets to keep visible. */
export type AuditMode = "off" | "ambiguous" | "ambiguous+name";

type Action =
  | { t: "progress"; phase: string }
  | { t: "ready"; model: ClientModel }
  | { t: "error"; message: string }
  | { t: "toggleExpand"; key: string }
  | { t: "collapseLevel" }
  | { t: "select"; id: string | null }
  | { t: "hover"; id: string | null }
  | { t: "requestFit" }
  | { t: "setKindFilter"; kind: string; hidden: boolean }
  | { t: "setEdgeTypeFilter"; type: string; hidden: boolean }
  | { t: "setMinConfidence"; value: number }
  | { t: "clearFilters" }
  | { t: "setFocusTarget"; id: string | null }
  | { t: "setLens"; lens: LensId }
  | { t: "setAudit"; mode: AuditMode }
  | { t: "toggleImpact" }
  | { t: "toggleFocus" }
  | { t: "setFocusDepth"; depth: number }
  | { t: "toggleCoupling" }
  | { t: "setCochange"; map: CochangeMap }
  | { t: "resetView" };

/** Depth of a cluster key in the tree (root galaxy = 0). Lets collapseLevel
 *  shut the deepest-expanded branch first ("one level up"). */
function depthOf(model: ClientModel, key: string): number {
  return (model.ancestors.get(key)?.length ?? 1) - 1;
}

/** Returns a NEW expanded set with every ancestor cluster of each node in
 *  `nodeIds` opened, so the highlighted members surface as visible reps. Shared
 *  by the impact and neighborhood-focus overlays. */
function expandToReveal(
  model: ClientModel,
  expanded: Set<string>,
  nodeIds: Iterable<string>,
): Set<string> {
  const next = new Set(expanded);
  for (const id of nodeIds) {
    const clusterKey = model.clusterOfNode.get(id) ?? id;
    const chain = model.ancestors.get(clusterKey);
    if (!chain) continue;
    for (const ak of chain) {
      const c = model.byKey.get(ak);
      if (c && c.children.length > 0) next.add(ak);
    }
  }
  return next;
}

/** Edge types to TRAVERSE for the focus BFS: everything not hidden by the
 *  active filters/lens (filters store the HIDDEN set). Empty hidden set → all. */
function focusEdgeTypes(hidden: Set<string>): Set<string> {
  if (hidden.size === 0) return new Set(ALL_EDGE_TYPES);
  return new Set(ALL_EDGE_TYPES.filter((t) => !hidden.has(t)));
}

function reducer(state: State, a: Action): State {
  switch (a.t) {
    case "progress":
      return { ...state, status: { kind: "loading", phase: a.phase } };
    case "ready": {
      // Expand the root galaxy by default so the first level is visible.
      const expanded = new Set<string>([a.model.rootKey]);
      return {
        ...state,
        status: { kind: "ready" },
        model: a.model,
        expanded,
        fitNonce: state.fitNonce + 1,
      };
    }
    case "error":
      return { ...state, status: { kind: "error", message: a.message } };
    case "toggleExpand": {
      const expanded = new Set(state.expanded);
      if (expanded.has(a.key)) expanded.delete(a.key);
      else expanded.add(a.key);
      return { ...state, expanded, fitNonce: state.fitNonce + 1 };
    }
    case "collapseLevel": {
      if (!state.model || state.expanded.size === 0) return state;
      // Collapse the deepest currently-expanded cluster, but never the root
      // galaxy (keeps the constellation framed).
      let deepest: string | null = null;
      let deepestDepth = -1;
      for (const key of state.expanded) {
        if (key === state.model.rootKey) continue;
        const d = depthOf(state.model, key);
        if (d > deepestDepth) {
          deepestDepth = d;
          deepest = key;
        }
      }
      if (deepest === null) {
        // Nothing but the root expanded: just clear selection.
        if (state.selected === null) return state;
        return { ...state, selected: null, fitNonce: state.fitNonce + 1 };
      }
      const expanded = new Set(state.expanded);
      expanded.delete(deepest);
      return { ...state, expanded, selected: null, fitNonce: state.fitNonce + 1 };
    }
    case "select":
      // Selecting a different node invalidates a live impact / focus overlay.
      return {
        ...state,
        selected: a.id,
        fitNonce: state.fitNonce + 1,
        impact: a.id === state.selected ? state.impact : null,
        focus: a.id === state.selected ? state.focus : null,
      };
    case "hover":
      return { ...state, hovered: a.id };
    case "requestFit":
      return { ...state, fitNonce: state.fitNonce + 1 };
    case "setKindFilter": {
      const kinds = new Set(state.filters.kinds);
      if (a.hidden) kinds.add(a.kind);
      else kinds.delete(a.kind);
      // A manual filter edit is no longer a clean preset → drop the lens chip.
      return { ...state, filters: { ...state.filters, kinds }, lens: "all", emphasis: "none" };
    }
    case "setEdgeTypeFilter": {
      const edgeTypes = new Set(state.filters.edgeTypes);
      if (a.hidden) edgeTypes.add(a.type);
      else edgeTypes.delete(a.type);
      return { ...state, filters: { ...state.filters, edgeTypes }, lens: "all", emphasis: "none" };
    }
    case "setMinConfidence":
      return {
        ...state,
        filters: { ...state.filters, minConfidence: a.value },
        lens: "all",
        emphasis: "none",
      };
    case "clearFilters":
      return {
        ...state,
        filters: { kinds: new Set(), edgeTypes: new Set(), minConfidence: 0 },
        lens: "all",
        emphasis: "none",
        audit: "off",
      };
    case "setLens": {
      // Apply the preset to the EXISTING filter state + emphasis. Do NOT bump
      // fitNonce — switching a lens must not yank the camera. Clearing audit so
      // the two presets never fight over edge visibility.
      const ls = resolveLens(a.lens);
      return {
        ...state,
        lens: a.lens,
        emphasis: ls.emphasis,
        filters: {
          kinds: ls.kinds,
          edgeTypes: ls.edgeTypes,
          minConfidence: ls.minConfidence,
        },
        audit: "off",
      };
    }
    case "setAudit":
      // Toggling audit must not move the camera (no fitNonce bump).
      return { ...state, audit: a.mode };
    case "toggleCoupling":
      return { ...state, coupling: !state.coupling };
    case "setCochange":
      return { ...state, cochange: a.map };
    case "toggleImpact": {
      if (state.impact) return { ...state, impact: null };
      if (!state.model || !state.selected) return state;
      const result = computeImpact(state.model, state.selected);
      // Auto-expand clusters containing impacted nodes so the highlight is
      // visible (every ancestor on each impacted node's chain).
      const expanded = expandToReveal(state.model, state.expanded, [
        ...result.impacted,
        ...result.coveringTests,
        state.selected,
      ]);
      return { ...state, impact: result, expanded, fitNonce: state.fitNonce + 1 };
    }
    case "toggleFocus": {
      if (state.focus) return { ...state, focus: null, fitNonce: state.fitNonce + 1 };
      if (!state.model || !state.selected) return state;
      const result = computeNeighborhood(
        state.model.drawEdges,
        state.selected,
        state.focusDepth,
        focusEdgeTypes(state.filters.edgeTypes),
      );
      // Auto-expand clusters containing neighborhood members so they surface.
      const expanded = expandToReveal(state.model, state.expanded, result.nodes);
      // Focus owns the camera: clear a live impact overlay so they don't fight.
      return { ...state, focus: result, impact: null, expanded, fitNonce: state.fitNonce + 1 };
    }
    case "setFocusDepth": {
      const depth = clampDepth(a.depth);
      if (depth === state.focusDepth) return state;
      // If focus is live, recompute at the new depth and re-reveal members.
      if (state.focus && state.model && state.selected) {
        const result = computeNeighborhood(
          state.model.drawEdges,
          state.selected,
          depth,
          focusEdgeTypes(state.filters.edgeTypes),
        );
        const expanded = expandToReveal(state.model, state.expanded, result.nodes);
        return { ...state, focusDepth: depth, focus: result, expanded, fitNonce: state.fitNonce + 1 };
      }
      return { ...state, focusDepth: depth };
    }
    case "setFocusTarget":
      return {
        ...state,
        focusTarget: a.id,
        // Bump fitNonce when setting a non-null target so Controls.tsx picks it up.
        fitNonce: a.id !== null ? state.fitNonce + 1 : state.fitNonce,
      };
    case "resetView": {
      if (!state.model) return state;
      const expanded = new Set<string>([state.model.rootKey]);
      return {
        ...state,
        expanded,
        selected: null,
        focusTarget: null,
        lens: "all",
        emphasis: "none",
        audit: "off",
        impact: null,
        focus: null,
        coupling: false,
        filters: { kinds: new Set(), edgeTypes: new Set(), minConfidence: 0 },
        fitNonce: state.fitNonce + 1,
      };
    }
  }
}

interface Store extends State {
  toggleExpand(key: string): void;
  collapseLevel(): void;
  select(id: string | null): void;
  hover(id: string | null): void;
  requestFit(): void;
  setKindFilter(kind: string, hidden: boolean): void;
  setEdgeTypeFilter(type: string, hidden: boolean): void;
  setMinConfidence(value: number): void;
  clearFilters(): void;
  setFocusTarget(id: string | null): void;
  setLens(lens: LensId): void;
  setAudit(mode: AuditMode): void;
  toggleImpact(): void;
  toggleFocus(): void;
  setFocusDepth(depth: number): void;
  toggleCoupling(): void;
  setCochange(map: CochangeMap): void;
  resetView(): void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch]: [State, Dispatch<Action>] = useReducer<
    (state: State, action: Action) => State
  >(reducer, {
    status: { kind: "loading", phase: "starting" },
    model: null,
    expanded: new Set<string>(),
    selected: null,
    hovered: null,
    fitNonce: 0,
    filters: { kinds: new Set<string>(), edgeTypes: new Set<string>(), minConfidence: 0 },
    focusTarget: null,
    lens: "all",
    emphasis: "none",
    audit: "off",
    impact: null,
    coupling: false,
    cochange: null,
    focus: null,
    focusDepth: DEFAULT_FOCUS_DEPTH,
  });

  useEffect(() => {
    // Static export mode (graph-data.js baked window.__REPOSKEIN_GRAPH__):
    // build the model on the main thread (the worker can't see `window`) and
    // skip all network fetches. Deferred a microtask so the loader paints.
    const baked = staticPayload();
    if (baked) {
      let cancelled = false;
      Promise.resolve().then(() => {
        if (cancelled) return;
        try {
          dispatch({ t: "progress", phase: "parsing baked graph" });
          const result = buildStaticResult(baked);
          if (!cancelled) dispatch({ t: "ready", model: fromWorker(result) });
        } catch (err) {
          if (!cancelled)
            dispatch({
              t: "error",
              message: err instanceof Error ? err.message : String(err),
            });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    const worker = new GraphWorker();
    worker.onmessage = (
      e: MessageEvent<WorkerResult | WorkerError | WorkerProgress>
    ) => {
      const m = e.data;
      if (m.type === "progress") dispatch({ t: "progress", phase: m.phase });
      else if (m.type === "error") dispatch({ t: "error", message: m.message });
      else if (m.type === "result")
        dispatch({ t: "ready", model: fromWorker(m) });
    };
    worker.onerror = (e) => dispatch({ t: "error", message: e.message });
    worker.postMessage({ cmd: "load" });
    return () => worker.terminate();
  }, []);

  const store = useMemo<Store>(
    () => ({
      ...state,
      toggleExpand: (key) => dispatch({ t: "toggleExpand", key }),
      collapseLevel: () => dispatch({ t: "collapseLevel" }),
      select: (id) => dispatch({ t: "select", id }),
      hover: (id) => dispatch({ t: "hover", id }),
      requestFit: () => dispatch({ t: "requestFit" }),
      setKindFilter: (kind, hidden) => dispatch({ t: "setKindFilter", kind, hidden }),
      setEdgeTypeFilter: (type, hidden) => dispatch({ t: "setEdgeTypeFilter", type, hidden }),
      setMinConfidence: (value) => dispatch({ t: "setMinConfidence", value }),
      clearFilters: () => dispatch({ t: "clearFilters" }),
      setFocusTarget: (id) => dispatch({ t: "setFocusTarget", id }),
      setLens: (lens) => dispatch({ t: "setLens", lens }),
      setAudit: (mode) => dispatch({ t: "setAudit", mode }),
      toggleImpact: () => dispatch({ t: "toggleImpact" }),
      toggleFocus: () => dispatch({ t: "toggleFocus" }),
      setFocusDepth: (depth) => dispatch({ t: "setFocusDepth", depth }),
      toggleCoupling: () => dispatch({ t: "toggleCoupling" }),
      setCochange: (map) => dispatch({ t: "setCochange", map }),
      resetView: () => dispatch({ t: "resetView" }),
    }),
    [state]
  );

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore must be used within StoreProvider");
  return s;
}
