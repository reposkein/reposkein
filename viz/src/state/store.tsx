import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import GraphWorker from "../data/worker/graph.worker.ts?worker";
import { fromWorker, expandToReveal, type ClientModel } from "../data/clientModel";
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
import {
  useChannelSetter,
  useChannelValue,
  useNewChannel,
  type Channel,
} from "./channel";

type Status =
  | { kind: "loading"; phase: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

interface Filters {
  kinds: Set<string>;      // hidden symbol kinds; empty = show all
  edgeTypes: Set<string>;  // hidden edge types; empty = show all
  minConfidence: number;   // 0..1, default 0
}

/** Live "showing N of M connections" readout: drawn = bundles rendered after
 *  the cap, total = pre-cap bundle count. Published by EdgeLines through the
 *  edgeStats CHANNEL (not the reducer) — it updates on every render pass, and
 *  only the HeaderBar readout should re-render for it. */
export interface EdgeStats {
  drawn: number;
  total: number;
}

export interface State {
  status: Status;
  model: ClientModel | null;
  expanded: Set<string>;
  selected: string | null;
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
  /** Guided cinematic tour is active (drives the TourController + caption HUD).
   *  Pure UI flag; the tour reuses the existing expand/select/fit/focus actions. */
  tour: boolean;
  /** Holten edge-bundling straighten factor [0,1]: 1 = curves hug the
   *  hierarchy, 0 = straight chords (reproduces the pre-bundling render). */
  bundleBeta: number;
  /** Gentle idle azimuth drift after a few seconds of no interaction.
   *  DEFAULT OFF: with `frameloop="demand"` an always-on drift means the GPU
   *  never sleeps, and an unrequested camera move fights the reader. Controls
   *  respects this flag; a keyboard binding lands with the shortcut pass. */
  idleDrift: boolean;
}

/** Confidence-audit preset: which low-confidence buckets to keep visible. */
export type AuditMode = "off" | "ambiguous" | "ambiguous+name";

export type Action =
  | { t: "progress"; phase: string }
  | { t: "ready"; model: ClientModel }
  | { t: "error"; message: string }
  | { t: "toggleExpand"; key: string }
  | { t: "collapseLevel" }
  | { t: "select"; id: string | null }
  | { t: "requestFit" }
  | { t: "revealAndSelect"; id: string; fly?: boolean; collapseDeeper?: boolean }
  | { t: "revealWithoutRefit"; keys: string[] }
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
  | { t: "startTour" }
  | { t: "exitTour" }
  | { t: "resetView" }
  | { t: "resetExpansion" }
  | { t: "setBundleBeta"; value: number }
  | { t: "setIdleDrift"; on: boolean };

/** Depth of a cluster key in the tree (root galaxy = 0). Lets collapseLevel
 *  shut the deepest-expanded branch first ("one level up"). */
function depthOf(model: ClientModel, key: string): number {
  return (model.ancestors.get(key)?.length ?? 1) - 1;
}

/** Edge types to TRAVERSE for the focus BFS: everything not hidden by the
 *  active filters/lens (filters store the HIDDEN set). Empty hidden set → all. */
function focusEdgeTypes(hidden: Set<string>): Set<string> {
  if (hidden.size === 0) return new Set(ALL_EDGE_TYPES);
  return new Set(ALL_EDGE_TYPES.filter((t) => !hidden.has(t)));
}

/** The single source of truth for "wipe expansion + overlays back to a clean
 *  top-level frame". Every reset path (resetView, resetExpansion, startTour,
 *  exitTour's lens/filter clear) composes THIS so they never diverge. Pass
 *  `extra` to layer on the path-specific fields. Assumes state.model is set. */
function cleanSlate(state: State, extra: Partial<State> = {}): State {
  return {
    ...state,
    expanded: new Set<string>([state.model!.rootKey]),
    selected: null,
    focusTarget: null,
    impact: null,
    focus: null,
    fitNonce: state.fitNonce + 1,
    ...extra,
  };
}

/** The default lens/filter state shared by resetView + exitTour so the scene
 *  returns to the neutral "all" lens with no filters (never a lingering
 *  calls-only / filtered view). */
function defaultLensFilters(): Partial<State> {
  return {
    lens: "all",
    emphasis: "none",
    audit: "off",
    filters: { kinds: new Set<string>(), edgeTypes: new Set<string>(), minConfidence: 0 },
  };
}

export function reducer(state: State, a: Action): State {
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
    case "requestFit":
      return { ...state, fitNonce: state.fitNonce + 1 };
    case "revealAndSelect": {
      // ONE transition for "make this node visible and inspect it": expand its
      // ancestor chain, select it, optionally fly to it — with a SINGLE fitNonce
      // bump. The callers used to dispatch toggleExpand per ancestor plus select
      // plus setFocusTarget, so a search hit bumped fitNonce N+2 times and every
      // intermediate expansion was a separately-reduced state the scene could
      // have rendered.
      if (!state.model) return state;
      const model = state.model;
      const expanded = expandToReveal(model, state.expanded, [a.id]);
      if (a.collapseDeeper) {
        // Breadcrumb semantics: after opening the chain UP to this crumb, shut
        // every still-expanded cluster strictly BELOW it (an ancestor chain is
        // root→self, so its index in a descendant's chain is that descendant's
        // depth measured from the root).
        const targetKey = model.clusterOfNode.get(a.id) ?? a.id;
        const targetDepth = depthOf(model, targetKey);
        for (const key of [...expanded]) {
          if (key === model.rootKey) continue;
          const chain = model.ancestors.get(key);
          if (!chain) continue;
          if (chain.indexOf(targetKey) !== -1 && chain.length - 1 > targetDepth) {
            expanded.delete(key);
          }
        }
      }
      const sameSelection = a.id === state.selected;
      return {
        ...state,
        expanded,
        selected: a.id,
        focusTarget: a.fly ? a.id : state.focusTarget,
        impact: sameSelection ? state.impact : null,
        focus: sameSelection ? state.focus : null,
        fitNonce: state.fitNonce + 1,
      };
    }
    case "revealWithoutRefit": {
      // Open explicit cluster keys with NO camera consequence: the tour computes
      // its own stop framing afterwards, so refitting per expansion would yank
      // the camera mid-sequence. Set-union (not toggle) so a key already open
      // stays open instead of closing.
      if (a.keys.length === 0) return state;
      const expanded = new Set(state.expanded);
      let changed = false;
      for (const key of a.keys) {
        if (expanded.has(key)) continue;
        expanded.add(key);
        changed = true;
      }
      if (!changed) return state;
      return { ...state, expanded };
    }
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
    case "startTour": {
      if (!state.model) return state;
      // Begin from a clean top-level frame so the tour's first overview stop
      // reads consistently regardless of prior navigation.
      return cleanSlate(state, { tour: true, emphasis: "none" });
    }
    case "exitTour":
      // Leave the camera where it is (no fitNonce bump); clear the tour flag +
      // the tour's focus/selection AND restore the default lens/filters so the
      // scene never lingers on a calls-only / filtered view.
      return {
        ...state,
        ...defaultLensFilters(),
        tour: false,
        focus: null,
        selected: null,
      };
    case "resetView": {
      if (!state.model) return state;
      return cleanSlate(state, { ...defaultLensFilters(), coupling: false });
    }
    case "resetExpansion": {
      if (!state.model) return state;
      // Wipe accumulated expansion + overlays back to the root frame (used by
      // the tour controller before each stop). Lens/filters left untouched so a
      // stop can set its own lens immediately after.
      return cleanSlate(state);
    }
    case "setBundleBeta":
      // Clamp [0,1]; no fitNonce bump — restyling must not yank the camera.
      return { ...state, bundleBeta: Math.max(0, Math.min(1, a.value)) };
    case "setIdleDrift":
      if (state.idleDrift === a.on) return state;
      return { ...state, idleDrift: a.on };
  }
}

/** The stable action surface. Every method is identity-stable for the lifetime
 *  of the provider (it only closes over `dispatch` and the channels), so a
 *  component that merely dispatches never re-renders when state changes. */
export interface Actions {
  toggleExpand(key: string): void;
  collapseLevel(): void;
  select(id: string | null): void;
  requestFit(): void;
  /** Expand the ancestor chain of `id`, select it, and (with `fly`) frame it —
   *  ONE reducer transition and ONE fitNonce bump. `collapseDeeper` additionally
   *  shuts clusters below the target (breadcrumb "go up to here"). */
  revealAndSelect(id: string, opts?: { fly?: boolean; collapseDeeper?: boolean }): void;
  /** Open explicit cluster keys without touching selection or the camera. */
  revealWithoutRefit(keys: string[]): void;
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
  startTour(): void;
  exitTour(): void;
  resetView(): void;
  resetExpansion(): void;
  setBundleBeta(value: number): void;
  setIdleDrift(on: boolean): void;
  /** Pointer-rate: writes the hover CHANNEL, not the reducer. */
  hover(id: string | null): void;
  /** Per-pass: writes the edgeStats CHANNEL, not the reducer. */
  setEdgeStats(stats: EdgeStats): void;
}

interface Channels {
  hovered: Channel<string | null>;
  edgeStats: Channel<EdgeStats>;
}

/** The merged read+write view kept for ergonomics at call sites that need both.
 *  Consumers that only need one half should prefer `useStoreState()` /
 *  `useActions()` so they re-render for less. */
export type Store = State & Actions;

const StateCtx = createContext<State | null>(null);
const ActionsCtx = createContext<Actions | null>(null);
const ChannelsCtx = createContext<Channels | null>(null);

export const INITIAL_STATE: State = {
  status: { kind: "loading", phase: "starting" },
  model: null,
  expanded: new Set<string>(),
  selected: null,
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
  tour: false,
  bundleBeta: 0.85,
  idleDrift: false,
};

/** Fresh initial state per provider — the Sets must not be shared across mounts
 *  (tests mount several) and the reducer treats them as owned values. */
function initialState(): State {
  return {
    ...INITIAL_STATE,
    expanded: new Set<string>(),
    filters: { kinds: new Set<string>(), edgeTypes: new Set<string>(), minConfidence: 0 },
  };
}

const sameEdgeStats = (a: EdgeStats, b: EdgeStats) =>
  a.drawn === b.drawn && a.total === b.total;

export function StoreProvider({ children }: { children: ReactNode }) {
  // React 19 dropped the 2-arg `useReducer<Reducer>` overload; the plain
  // (reducer, initialState) form infers [State, Dispatch<Action>] correctly.
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // Pointer-rate / per-pass channels. Created once; the context value is the
  // channel OBJECT, so publishing a value never re-renders a context consumer —
  // only the components that subscribed to the value itself.
  const hovered = useNewChannel<string | null>(null);
  const edgeStats = useNewChannel<EdgeStats>({ drawn: 0, total: 0 }, sameEdgeStats);
  const channels = useMemo<Channels>(() => ({ hovered, edgeStats }), [hovered, edgeStats]);

  useEffect(() => {
    // Static export mode (graph-data.js baked window.__REPOSKEIN_GRAPH__):
    // build the model on the main thread (the worker can't see `window`) and
    // skip all network fetches. Deferred a microtask so the loader paints.
    const baked = staticPayload();
    if (baked) {
      let cancelled = false;
      Promise.resolve().then(async () => {
        if (cancelled) return;
        try {
          dispatch({ t: "progress", phase: "parsing baked graph" });
          const result = await buildStaticResult(baked);
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

  // Stable for the provider's lifetime: `dispatch` is stable and the channels
  // are created once, so this object is created ONCE. That is the whole point of
  // splitting dispatch from state.
  const actions = useMemo<Actions>(
    () => ({
      toggleExpand: (key) => dispatch({ t: "toggleExpand", key }),
      collapseLevel: () => dispatch({ t: "collapseLevel" }),
      select: (id) => dispatch({ t: "select", id }),
      requestFit: () => dispatch({ t: "requestFit" }),
      revealAndSelect: (id, opts) =>
        dispatch({
          t: "revealAndSelect",
          id,
          fly: opts?.fly,
          collapseDeeper: opts?.collapseDeeper,
        }),
      revealWithoutRefit: (keys) => dispatch({ t: "revealWithoutRefit", keys }),
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
      startTour: () => dispatch({ t: "startTour" }),
      exitTour: () => dispatch({ t: "exitTour" }),
      resetView: () => dispatch({ t: "resetView" }),
      resetExpansion: () => dispatch({ t: "resetExpansion" }),
      setBundleBeta: (value) => dispatch({ t: "setBundleBeta", value }),
      setIdleDrift: (on) => dispatch({ t: "setIdleDrift", on }),
      hover: (id) => hovered.set(id),
      setEdgeStats: (stats) => edgeStats.set(stats),
    }),
    [hovered, edgeStats]
  );

  return (
    <ChannelsCtx.Provider value={channels}>
      <ActionsCtx.Provider value={actions}>
        <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
      </ActionsCtx.Provider>
    </ChannelsCtx.Provider>
  );
}

/** Reducer state. Re-renders on any reducer transition. */
export function useStoreState(): State {
  const s = useContext(StateCtx);
  if (!s) throw new Error("useStoreState must be used within StoreProvider");
  return s;
}

/** The stable action surface. NEVER re-renders the caller. */
export function useActions(): Actions {
  const a = useContext(ActionsCtx);
  if (!a) throw new Error("useActions must be used within StoreProvider");
  return a;
}

function useChannels(): Channels {
  const c = useContext(ChannelsCtx);
  if (!c) throw new Error("channel hooks must be used within StoreProvider");
  return c;
}

/** The hovered node id, at pointer rate. Subscribing re-renders ONLY the
 *  caller — the HUD chrome must never read this. */
export function useHovered(): string | null {
  return useChannelValue(useChannels().hovered);
}

/** Stable hover publisher (scene pointer handlers). */
export function useSetHovered(): (id: string | null) => void {
  return useChannelSetter(useChannels().hovered);
}

/** The live bundle-draw counters, published per EdgeLines pass. */
export function useEdgeStats(): EdgeStats {
  return useChannelValue(useChannels().edgeStats);
}

/** Stable edgeStats publisher (EdgeLines). */
export function useSetEdgeStats(): (stats: EdgeStats) => void {
  return useChannelSetter(useChannels().edgeStats);
}

/** State + actions in one object, for the many call sites that need both.
 *  Re-renders with reducer state (same as before the split) — hovered and
 *  edgeStats are deliberately NOT part of it. */
export function useStore(): Store {
  const state = useStoreState();
  const actions = useActions();
  return useMemo(() => ({ ...state, ...actions }), [state, actions]);
}
