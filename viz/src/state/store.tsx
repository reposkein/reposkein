import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import GraphWorker from "../data/worker/graph.worker.ts?worker";
import {
  fromWorker,
  expandToReveal,
  representativeFor,
  visibleClusters,
  type ClientModel,
} from "../data/clientModel";
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
import { getCameraPose, isNodeOnScreenNow, type CameraPose } from "./cameraPose";
import type { HopMemory } from "../data/navigate";
import {
  pushView,
  resetViewHistory,
  stepBack,
  stepForward,
  type ViewSnapshot,
} from "./viewHistory";

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
 *  only the status bar's readout (panels/StatusBar.tsx, REP-18) should
 *  re-render for it. */
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
  /** An EXACT camera pose to restore, set only by view history (V4 §4). Paired
   *  with `poseNonce` the same way `focusTarget` is paired with `fitNonce`:
   *  Controls' restore effect keys off the nonce, so restoring twice to the same
   *  pose still moves the camera, and a re-render that changes nothing else
   *  never does. Deliberately separate from the fit path — a restore reproduces
   *  the frame the reader was looking at, it does NOT re-fit. */
  poseTarget: CameraPose | null;
  poseNonce: number;
  /** ANCHOR-AWARE HOP (V4 §5). How the last arrow/Tab hop got here, so the
   *  opposite arrow returns to the anchor instead of walking the new node's own
   *  ring. Self-invalidating rather than cleared by every other action:
   *  `nextHop` only honours a memory whose `to` IS the current selection, so a
   *  selection moved by any other means silently retires it. */
  lastHop: HopMemory | null;
  /** Bumped on every hop, so the in-scene trail line can retrigger even when
   *  the same pair is hopped twice. The trail reads `lastHop` for endpoints. */
  hopNonce: number;
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
   *  respects this flag; `d` and the palette's "Toggle idle drift" row flip it
   *  (V4 §6 — the binding this field waited for since V0). */
  idleDrift: boolean;
  /** In-scene name labels. The minimap / legend / filters / help surfaces used
   *  to live here too as `showMinimap` / `showLegend` booleans; V3 moved them to
   *  `panels/layerState.ts`, which holds ONE nullable layer id so two of them
   *  can never be open at once (they both defaulted to `true` and both docked
   *  bottom-left — the overlap this phase exists to fix). Labels stay in the
   *  reducer because they're a SCENE toggle, read inside <Canvas>. */
  showLabels: boolean;
  /** Bumped by `retryLoad()` to re-run the loader effect after an error. */
  loadNonce: number;
}

/** Confidence-audit preset: which low-confidence buckets to keep visible. */
export type AuditMode = "off" | "ambiguous" | "ambiguous+name";

export type Action =
  | { t: "progress"; phase: string }
  | { t: "ready"; model: ClientModel }
  | { t: "error"; message: string }
  | { t: "toggleExpand"; key: string }
  | { t: "collapseBranch" }
  | { t: "collapseToFileLevel" }
  | { t: "select"; id: string | null; frame?: boolean }
  | { t: "requestFit" }
  | { t: "revealAndSelect"; id: string; fly?: boolean; collapseDeeper?: boolean }
  | { t: "revealWithoutRefit"; keys: string[] }
  | { t: "hop"; id: string; memory: HopMemory; fly: boolean }
  | { t: "restoreView"; snapshot: ViewSnapshot }
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
  | { t: "setIdleDrift"; on: boolean }
  | { t: "retryLoad" }
  | { t: "toggleLabels" };

/** Depth of a cluster key in the tree (root galaxy = 0). Lets
 *  `revealAndSelect`'s `collapseDeeper` tell "below the target" from "at or
 *  above it" when a breadcrumb crumb walks back up. */
function depthOf(model: ClientModel, key: string): number {
  return (model.ancestors.get(key)?.length ?? 1) - 1;
}

/** Edge types to TRAVERSE for the focus BFS: everything not hidden by the
 *  active filters/lens (filters store the HIDDEN set). Empty hidden set → all. */
function focusEdgeTypes(hidden: Set<string>): Set<string> {
  if (hidden.size === 0) return new Set(ALL_EDGE_TYPES);
  return new Set(ALL_EDGE_TYPES.filter((t) => !hidden.has(t)));
}

/** Re-anchor the selection after a collapse that may have hidden it.
 *
 *  A collapse must never leave `selected` pointing at a star nobody can see:
 *  the breadcrumb would name an invisible node and Controls would frame an
 *  empty layout slot. So the selection moves to the backing graph node of the
 *  DEEPEST cluster still visible on its own chain — which is exactly the
 *  cluster that just closed. That is what makes `x` read as "climb one level"
 *  and be pressable again (symbol → file → directory → …).
 *
 *  Returns the unchanged selection when it is still visible, and null when the
 *  surviving cluster has no graph node behind it (a synthetic directory). */
function reanchorSelection(
  model: ClientModel,
  selected: string | null,
  expanded: Set<string>,
): string | null {
  if (!selected) return null;
  const own = model.clusterOfNode.get(selected) ?? selected;
  const rep = representativeFor(model, selected, visibleClusters(model, expanded));
  if (!rep) return null;
  if (rep === own) return selected; // still on screen — nothing to re-anchor
  return model.byKey.get(rep)?.nodeId ?? null;
}

/** Shared tail of both collapse semantics (`x` and `⇧x`): install the new
 *  expansion, re-anchor the selection, drop overlays that were anchored to a
 *  selection that just changed, and refit (the visible set moved). */
function afterCollapse(state: State, expanded: Set<string>): State {
  const selected = reanchorSelection(state.model!, state.selected, expanded);
  const sameSelection = selected === state.selected;
  return {
    ...state,
    expanded,
    selected,
    focusTarget: null,
    impact: sameSelection ? state.impact : null,
    focus: sameSelection ? state.focus : null,
    fitNonce: state.fitNonce + 1,
  };
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

/** The cluster `x` would close: the deepest EXPANDED strict ancestor of the
 *  selection, or null when there is none (no selection, or nothing but the root
 *  galaxy left open — which never closes).
 *
 *  Exported and shared with the action wrapper on purpose. The wrapper has to
 *  know whether a collapse will actually do anything, so that a no-op `x` does
 *  not push a view-history entry (fix round 1, `I2`: holding `x` at the top of
 *  the tree grew the back-stack with identical views and, under the 50 cap,
 *  evicted the real trail). Having the wrapper re-derive that condition would be
 *  two copies of one rule; this is one copy with two callers. */
export function collapseBranchTarget(
  model: ClientModel,
  selected: string | null,
  expanded: Set<string>,
): string | null {
  if (!selected) return null;
  const own = model.clusterOfNode.get(selected) ?? selected;
  const chain = model.ancestors.get(own);
  if (!chain) return null;
  for (let i = chain.length - 2; i >= 0; i--) {
    const key = chain[i]!;
    if (key === model.rootKey) break; // the root galaxy never closes
    if (expanded.has(key)) return key;
  }
  return null;
}

/** Whether `⇧x` has anything to close. Same wrapper-guard reason as above. */
export function hasExpansionAboveFileLevel(
  model: ClientModel,
  expanded: Set<string>,
): boolean {
  for (const key of expanded) {
    if (model.byKey.get(key)?.kind === "file") return true;
  }
  return false;
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
    /** `x` — SCOPED collapse (Astrolabe V4 §2). Closes the deepest expanded
     *  STRICT ancestor of the selection: a selected symbol closes its file, a
     *  selected file closes its directory, and so on up to (never including)
     *  the root galaxy. Siblings elsewhere in the tree are untouched — that is
     *  the whole difference from V3's global-deepest `collapseLevel`, which
     *  could shut a branch on the other side of the graph from what you were
     *  reading. No selection → nothing to scope to, so it is a no-op. */
    case "collapseBranch": {
      const model = state.model;
      if (!model) return state;
      const victim = collapseBranchTarget(model, state.selected, state.expanded);
      if (victim === null) return state;
      const expanded = new Set(state.expanded);
      expanded.delete(victim);
      return afterCollapse(state, expanded);
    }
    /** `⇧x` — collapse to FILE level, globally (Astrolabe V4 §2). Every
     *  expansion ABOVE file level closes, so the scene returns to clean
     *  file-level arcs while the directory structure you navigated to stays
     *  open. Deliberately not `resetExpansion`: this is a zoom-out, not a
     *  clean slate — lens, filters and overlays survive it. */
    case "collapseToFileLevel": {
      const model = state.model;
      if (!model) return state;
      const expanded = new Set<string>();
      let changed = false;
      for (const key of state.expanded) {
        if (model.byKey.get(key)?.kind === "file") {
          changed = true;
          continue;
        }
        expanded.add(key);
      }
      if (!changed) return state;
      return afterCollapse(state, expanded);
    }
    case "select":
      // Selecting a different node invalidates a live impact / focus overlay.
      //
      // DESELECTION IS NOT A CAMERA MOVE (V4 §3). `select(null)` deliberately
      // does NOT bump fitNonce: with nothing selected, Controls' fit effect
      // falls through to "frame every visible cluster", so bumping would turn
      // Esc — and a misclick on empty space — into an unrequested reframe of
      // the whole constellation.
      //
      // NEITHER IS SELECTING SOMETHING ALREADY IN VIEW (V4 §6, fix round 1
      // `I3`). `frame` is the caller's frustum verdict: clicking a star you can
      // already see should not swing the camera to centre it, for the same
      // reason a hop to an on-screen neighbour doesn't. The decision lives in
      // the action wrapper (which can read the live camera) rather than here, so
      // this stays a pure function of its arguments. `undefined` means FRAME —
      // "unknown" must always resolve to moving the camera, since a wasted
      // flight is cheap next to a selection the reader cannot find.
      //
      // `focusTarget` is cleared either way: it is a one-shot fly request, and
      // a stale one surviving into a later fitNonce bump is exactly the V1 bug
      // ("flew to the node I looked at two clicks ago") that `revealAndSelect`
      // already guards against.
      return {
        ...state,
        selected: a.id,
        focusTarget: null,
        fitNonce:
          a.id !== null && a.frame !== false ? state.fitNonce + 1 : state.fitNonce,
        impact: a.id === state.selected ? state.impact : null,
        focus: a.id === state.selected ? state.focus : null,
      };
    case "requestFit":
      return { ...state, fitNonce: state.fitNonce + 1 };
    case "revealAndSelect": {
      // ONE transition for "make this node visible and inspect it": expand its
      // ancestor chain, select it, and — ONLY when `fly` is set — bump
      // fitNonce once and set focusTarget so Controls flies there. `fly:false`
      // ("reveal without flying") touches neither: no fitNonce bump, no
      // camera consequence, period. The callers used to dispatch toggleExpand
      // per ancestor plus select plus setFocusTarget. React's auto-batching
      // already collapsed those into one render, so this is not about firing
      // the camera effect less; it is about atomicity — no half-expanded /
      // selected-but-hidden intermediate state exists to be read or reasoned
      // about, and fitNonce stays a truthful count of user FLY intents rather
      // than of dispatches.
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
        // INVARIANT: focusTarget is only ever valid for the fitNonce bump it
        // accompanies. Controls' fit effect re-reads `store.focusTarget` on
        // EVERY fitNonce change (not only the change that set it) — so a
        // target left over from an earlier fly would hijack a later, unrelated
        // reframe. Flying sets it; anything else (including a `fly:false`
        // reveal) clears it outright, never inherits the prior value.
        focusTarget: a.fly ? a.id : null,
        impact: sameSelection ? state.impact : null,
        focus: sameSelection ? state.focus : null,
        // A `fly:false` reveal ("reveal without flying") must not move the
        // camera AT ALL — not even via the "reframe to the current selection"
        // fallback Controls' effect runs on any fitNonce bump. Only bump the
        // refit trigger when actually flying.
        fitNonce: a.fly ? state.fitNonce + 1 : state.fitNonce,
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
    /** One arrow/Tab hop (V4 §5). Like `revealAndSelect` — reveal the target's
     *  chain and select it in ONE transition — plus the two things that make a
     *  hop a hop:
     *
     *   - `memory`, so the opposite arrow returns to the anchor;
     *   - `fly`, decided by the CALLER from a frustum check, not by the reducer.
     *     A neighbour already on screen must not move the camera: V3 flew on
     *     every hop, which yanked the view around a cluster the reader could
     *     already see whole. `fly:false` therefore bumps neither fitNonce nor
     *     focusTarget — the selection simply changes where the reader is
     *     looking.
     *
     *  `hopNonce` always bumps, so the trail line draws even for a hop that
     *  moves no camera and even when the same pair is hopped twice. */
    case "hop": {
      if (!state.model) return state;
      const expanded = expandToReveal(state.model, state.expanded, [a.id]);
      const sameSelection = a.id === state.selected;
      return {
        ...state,
        expanded,
        selected: a.id,
        focusTarget: a.fly ? a.id : null,
        fitNonce: a.fly ? state.fitNonce + 1 : state.fitNonce,
        impact: sameSelection ? state.impact : null,
        focus: sameSelection ? state.focus : null,
        lastHop: a.memory,
        hopNonce: state.hopNonce + 1,
      };
    }
    /** `[` / `]` — restore a remembered view WHOLE (V4 §4): selection,
     *  expansion and camera pose in ONE transition, so no intermediate frame
     *  exists where the expansion is back but the camera isn't.
     *
     *  Notably it does NOT bump fitNonce. A restore reproduces the exact pose
     *  the reader was looking at, via `poseNonce`; letting the fit effect run
     *  as well would immediately re-frame the visible set and overwrite that
     *  pose with a merely plausible one — "Back took me somewhere near where
     *  I was". `focusTarget` is cleared for the same reason.
     *
     *  Overlays are dropped: `impact` and `focus` are anchored to a selection
     *  and a filter set that the snapshot does not carry, so restoring them
     *  would restore a stale computation. `lastHop` goes for the same reason —
     *  it describes a step between two nodes that has nothing to do with the
     *  view being restored, and leaving it would let the next arrow press
     *  "return" to an anchor from a different part of the session. */
    case "restoreView": {
      if (!state.model) return state;
      const { selected, expanded, pose } = a.snapshot;
      return {
        ...state,
        expanded,
        selected,
        focusTarget: null,
        impact: null,
        focus: null,
        lastHop: null,
        poseTarget: pose,
        poseNonce: state.poseNonce + 1,
      };
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
    case "retryLoad":
      // The error screen's Retry: back to loading and bump the nonce the loader
      // effect keys on, so the SAME code path that ran on mount runs again
      // (rather than a second, subtly-different retry path). Deliberately keeps
      // any prior model around — a retry after a transient fetch failure on a
      // reload shouldn't blank a graph that's already on screen.
      return { ...state, status: { kind: "loading", phase: "starting" }, loadNonce: state.loadNonce + 1 };
    case "toggleLabels":
      return { ...state, showLabels: !state.showLabels };
  }
}

/** The stable action surface. Every method is identity-stable for the lifetime
 *  of the provider (it only closes over `dispatch` and the channels), so a
 *  component that merely dispatches never re-renders when state changes. */
export interface Actions {
  toggleExpand(key: string): void;
  /** `x` — close the deepest expanded cluster ABOVE the selection (symbol →
   *  its file, file → its directory). Scoped: nothing else in the tree moves. */
  collapseBranch(): void;
  /** `⇧x` — close every expansion above file level, everywhere. */
  collapseToFileLevel(): void;
  /** Select a node, or DESELECT with null. Deselection never moves the camera
   *  (see the reducer's `select` case) — it is the tail of the layered Esc
   *  stack and what a misclick on empty space does. */
  select(id: string | null): void;
  requestFit(): void;
  /** Expand the ancestor chain of `id`, select it, and — only when `fly` is
   *  set — frame it: ONE reducer transition, and (only then) ONE fitNonce
   *  bump. `fly:false` ("reveal without flying") never touches the camera —
   *  no fitNonce bump, no focusTarget. `collapseDeeper` additionally shuts
   *  clusters below the target (breadcrumb "go up to here"). */
  revealAndSelect(id: string, opts?: { fly?: boolean; collapseDeeper?: boolean }): void;
  /** Open explicit cluster keys without touching selection or the camera. */
  revealWithoutRefit(keys: string[]): void;
  /** One neighbour hop: reveal + select `id`, remember how we got there, and
   *  fly ONLY when the caller determined the target is off screen. */
  hop(id: string, memory: HopMemory, fly: boolean): void;
  /** `[` — restore the previous view (selection + expansion + exact camera
   *  pose). No-op with an empty history; returns whether it moved. */
  historyBack(): boolean;
  /** `]` — the mirror of `historyBack`. */
  historyForward(): boolean;
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
  /** Re-run the graph load after an error (the error screen's Retry button). */
  retryLoad(): void;
  toggleLabels(): void;
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

/** A fresh initial state. A FACTORY, not a shared constant: `expanded` and
 *  `filters.kinds` / `filters.edgeTypes` are mutable Sets that the reducer
 *  treats as owned values, so handing the same object to two providers (tests
 *  mount several) would let one leak expansion into the other. */
export function createInitialState(): State {
  return {
    status: { kind: "loading", phase: "starting" },
    model: null,
    expanded: new Set<string>(),
    selected: null,
    fitNonce: 0,
    filters: { kinds: new Set<string>(), edgeTypes: new Set<string>(), minConfidence: 0 },
    focusTarget: null,
    poseTarget: null,
    poseNonce: 0,
    lastHop: null,
    hopNonce: 0,
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
    showLabels: true,
    loadNonce: 0,
  };
}

const sameEdgeStats = (a: EdgeStats, b: EdgeStats) =>
  a.drawn === b.drawn && a.total === b.total;

export function StoreProvider({ children }: { children: ReactNode }) {
  // React 19 dropped the 2-arg `useReducer<Reducer>` overload; the plain
  // (reducer, initialState) form infers [State, Dispatch<Action>] correctly.
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);

  // The latest state, readable from the action wrappers below WITHOUT making
  // them re-create on every dispatch. `actions` is identity-stable by contract
  // (a component that only dispatches must never re-render), and the history
  // wrappers need to read the CURRENT selection/expansion to snapshot it — so
  // they read it through here rather than closing over `state`.
  const stateRef = useRef(state);
  stateRef.current = state;

  /** The view we are in right now, as a history entry. The camera pose comes
   *  from the scene singleton, which is why recording can't live in the
   *  reducer. */
  const snapshot = useCallback(
    (): ViewSnapshot => ({
      selected: stateRef.current.selected,
      expanded: stateRef.current.expanded,
      pose: getCameraPose(),
    }),
    [],
  );

  /** Record the CURRENT view before a discrete navigation replaces it.
   *
   *  Every navigation the brief lists — a palette jump, an arrow hop, a
   *  breadcrumb click, a cluster expand/collapse — funnels through
   *  `revealAndSelect`, `toggleExpand` or one of the two collapses, so wrapping
   *  those four is the whole coverage. Doing it here rather than at each of the
   *  ~six call sites is deliberate: a new navigation UI gets history for free,
   *  and no site can push twice or forget.
   *
   *  Deliberately NOT recorded: `select` (an inspect, not a move — and it is
   *  what Esc/misclick deselection uses, which must not fill history with
   *  identical entries), `requestFit`, and `revealWithoutRefit` (the tour drives
   *  its own sequence; see `resetViewHistory` on tour entry).
   *
   *  A NO-OP NAVIGATION RECORDS NOTHING (fix round 1, `I2`). `x` at the top of
   *  the tree and `⇧x` with nothing above file level both return the same state
   *  object, so recording unconditionally meant holding `x` grew the back-stack
   *  with identical views — and under the 50 cap that EVICTED the real trail,
   *  turning `[` into a no-op right when the reader needed it. Callers whose
   *  transition is conditional pass a predicate; `pushView` additionally drops a
   *  push identical to the top of the stack, which covers the general case (two
   *  ⌘↵ reveals of the same already-visible node, say) without every wrapper
   *  having to reason about it. */
  const record = useCallback((willChange?: (s: State) => boolean) => {
    const s = stateRef.current;
    if (!s.model) return; // nothing meaningful to return to yet
    if (willChange && !willChange(s)) return;
    pushView(snapshot());
  }, [snapshot]);

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
    // Keyed on `loadNonce` (bumped by retryLoad) so the error screen's Retry
    // re-runs THIS effect — the same fetch/parse/layout path as the first load,
    // with a fresh worker — instead of a parallel retry implementation.
  }, [state.loadNonce]);

  // Stable for the provider's lifetime: `dispatch` is stable and the channels
  // are created once, so this object is created ONCE. That is the whole point of
  // splitting dispatch from state.
  const actions = useMemo<Actions>(
    () => ({
      toggleExpand: (key) => {
        record();
        dispatch({ t: "toggleExpand", key });
      },
      collapseBranch: () => {
        record((s) => collapseBranchTarget(s.model!, s.selected, s.expanded) !== null);
        dispatch({ t: "collapseBranch" });
      },
      collapseToFileLevel: () => {
        record((s) => hasExpansionAboveFileLevel(s.model!, s.expanded));
        dispatch({ t: "collapseToFileLevel" });
      },
      select: (id) =>
        // The frustum verdict is taken HERE, at dispatch time, so the reducer
        // stays pure — the same split the hop uses (fix round 1, `I3`).
        dispatch({ t: "select", id, frame: id === null ? false : !isNodeOnScreenNow(id) }),
      requestFit: () => dispatch({ t: "requestFit" }),
      revealAndSelect: (id, opts) => {
        record();
        dispatch({
          t: "revealAndSelect",
          id,
          fly: opts?.fly,
          collapseDeeper: opts?.collapseDeeper,
        });
      },
      revealWithoutRefit: (keys) => dispatch({ t: "revealWithoutRefit", keys }),
      hop: (id, memory, fly) => {
        record();
        dispatch({ t: "hop", id, memory, fly });
      },
      historyBack: () => {
        const previous = stepBack(snapshot());
        if (!previous) return false;
        dispatch({ t: "restoreView", snapshot: previous });
        return true;
      },
      historyForward: () => {
        const next = stepForward(snapshot());
        if (!next) return false;
        dispatch({ t: "restoreView", snapshot: next });
        return true;
      },
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
      // DECISION (V4 §8): every `cleanSlate` path CLEARS view history. A clean
      // slate is a fresh start, so walking `[` back into a pre-reset view would
      // resurrect exactly the expansion and overlays the reader just asked to be
      // rid of — and would restore a camera pose framing a scene that no longer
      // exists. Tour entry is a cleanSlate too, and the tour drives its own
      // sequence of reveals; leaving those in history would make `[` step
      // through a cinematic the reader already exited.
      startTour: () => {
        resetViewHistory();
        dispatch({ t: "startTour" });
      },
      exitTour: () => dispatch({ t: "exitTour" }),
      resetView: () => {
        resetViewHistory();
        dispatch({ t: "resetView" });
      },
      resetExpansion: () => {
        resetViewHistory();
        dispatch({ t: "resetExpansion" });
      },
      setBundleBeta: (value) => dispatch({ t: "setBundleBeta", value }),
      setIdleDrift: (on) => dispatch({ t: "setIdleDrift", on }),
      retryLoad: () => dispatch({ t: "retryLoad" }),
      toggleLabels: () => dispatch({ t: "toggleLabels" }),
      hover: (id) => hovered.set(id),
      setEdgeStats: (stats) => edgeStats.set(stats),
    }),
    [hovered, edgeStats, record, snapshot]
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
