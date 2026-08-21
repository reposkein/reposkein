/** Command palette registry (REP-13): the single typed source for every
 *  "Commands" group row. Pure data + pure `run` functions — no React, no DOM
 *  — so completeness (every listed store action reachable) and grouping are
 *  unit-testable without mounting the palette component.
 *
 *  `run` takes the store's `Actions` (dispatch-only, identity-stable) plus a
 *  read of `State` for the handful of commands whose behavior depends on
 *  current state (audit/bundling toggles read-then-flip; disabled predicates
 *  read `selected`/`tour`/`model`). `PaletteEnv` carries the two side effects
 *  that live OUTSIDE the reducer (screenshot capture is a scene singleton;
 *  clipboard write is a browser API) so this module stays free of imports
 *  from `scene/` or the DOM — a fake env makes every command testable. */

import type { Actions, State } from "./store";
import { LENS_ORDER, LENS_PRESETS } from "../data/lens";
import { canStepBack, canStepForward } from "./viewHistory";
import type { LayerId } from "../panels/layerState";

export interface PaletteEnv {
  /** Capture a PNG of the current view (scene/Screenshot.ts singleton). */
  screenshot(): void;
  /** Best-effort copy of the current URL (already kept in sync with
   *  `selected` by Root.tsx's navigate effect) to the clipboard. */
  copyLink(): void;
  /** Summon or dismiss a layer (panels/layerState.ts singleton).
   *
   *  These used to be `actions.toggleMinimap()` / `actions.toggleLegend()`
   *  reducer transitions. V3 moved layer visibility out of the reducer — it is
   *  ONE nullable id now, so exclusivity is structural — which makes toggling a
   *  layer a side effect on a module singleton, exactly like `screenshot`. It
   *  belongs in the env for the same reason those do: this module stays free of
   *  imports from `panels/` (only the `LayerId` type crosses, erased at
   *  compile time), so every command remains testable against a fake env. */
  toggleLayer(id: LayerId): void;
}

export interface CommandItem {
  id: string;
  label: string;
  /** Shown under the label when not overridden by `disabledReason`. */
  subtitle?: string;
  /** Right-aligned keyboard hint (display only — the palette's own keydown
   *  handler does the routing; this is not a global hotkey registration). */
  kbd?: string;
  group: "commands";
  /** Whether this command can run right now.
   *
   *  Takes `State` because that is where nearly every precondition lives. The
   *  two history rows are the exception: their precondition is the depth of the
   *  `state/viewHistory.ts` stacks, which are deliberately NOT reducer state
   *  (see that module's docstring — an entry holds a camera pose the reducer
   *  does not own). They read the singleton directly, which keeps them testable
   *  via `resetViewHistory()` and keeps the pose out of the reducer. */
  disabled(state: State): boolean;
  /** Explanatory subtitle shown INSTEAD of `subtitle` while disabled. */
  disabledReason?: string;
  run(actions: Actions, state: State, env: PaletteEnv): void;
}

const FOCUS_DEPTHS = [1, 2, 3] as const;

const NEEDS_SELECTION = "Select a node first";

/** The full command registry, in display order. Every store action named in
 *  the REP-13 brief (lenses, impact, focus + depth, coupling, audit, edge
 *  bundling, frame all, clean slate, tour, screenshot, copy link, and the
 *  labels/drift toggles) plus every V3 summoned layer (map, legend, filters,
 *  help — through `env.toggleLayer`) has exactly one command that reaches it —
 *  asserted by `commands.test.ts`'s completeness check. */
export function buildCommandRegistry(): CommandItem[] {
  const lensCommands: CommandItem[] = LENS_ORDER.map((id, i) => ({
    id: `lens-${id}`,
    label: `Lens: ${LENS_PRESETS[id].label}`,
    subtitle: LENS_PRESETS[id].hint,
    kbd: String(i + 1),
    group: "commands",
    disabled: () => false,
    run: (actions) => actions.setLens(id),
  }));

  const focusDepthCommands: CommandItem[] = FOCUS_DEPTHS.map((depth) => ({
    id: `focus-depth-${depth}`,
    label: `Focus depth ${depth}`,
    subtitle: "Sets the neighborhood BFS depth for the Focus overlay",
    disabledReason: NEEDS_SELECTION,
    group: "commands" as const,
    disabled: (s: State) => !s.selected,
    run: (actions: Actions) => actions.setFocusDepth(depth),
  }));

  return [
    ...lensCommands,
    {
      id: "impact",
      label: "Toggle impact overlay",
      subtitle: "Highlight transitive callers and covering tests of the selection",
      disabledReason: NEEDS_SELECTION,
      group: "commands",
      disabled: (s) => !s.selected,
      run: (actions) => actions.toggleImpact(),
    },
    {
      id: "focus",
      label: "Toggle focus neighborhood",
      subtitle: "Isolate the selected node's N-hop neighborhood and frame it",
      disabledReason: NEEDS_SELECTION,
      group: "commands",
      disabled: (s) => !s.selected,
      run: (actions) => actions.toggleFocus(),
    },
    ...focusDepthCommands,
    {
      id: "coupling",
      label: "Toggle coupling overlay",
      subtitle: "Git co-change links between files that change together",
      group: "commands",
      disabled: () => false,
      run: (actions) => actions.toggleCoupling(),
    },
    {
      id: "audit-ambiguous",
      label: "Audit: ambiguous edges only",
      subtitle: "Show ONLY ambiguous (guessed) edges — where the resolver is guessing",
      group: "commands",
      disabled: () => false,
      run: (actions, s) => actions.setAudit(s.audit === "ambiguous" ? "off" : "ambiguous"),
    },
    {
      id: "audit-ambiguous-name",
      label: "Audit: ambiguous + name match",
      subtitle: "Also include name_match edges (still low-confidence)",
      group: "commands",
      disabled: () => false,
      run: (actions, s) =>
        actions.setAudit(s.audit === "ambiguous+name" ? "off" : "ambiguous+name"),
    },
    {
      id: "bundling",
      label: "Toggle edge bundling",
      subtitle: "Switch between hierarchy-hugging curves and straight chords",
      group: "commands",
      disabled: () => false,
      run: (actions, s) => actions.setBundleBeta(s.bundleBeta > 0 ? 0 : 0.85),
    },
    {
      id: "frame-all",
      label: "Frame all",
      subtitle: "Refit the camera to what's currently on screen",
      kbd: "F",
      group: "commands",
      disabled: () => false,
      run: (actions) => actions.requestFit(),
    },
    {
      id: "history-back",
      label: "Back",
      subtitle: "The previous view — selection, expansion and camera together",
      kbd: "[",
      disabledReason: "Nothing to go back to",
      group: "commands",
      disabled: () => !canStepBack(),
      run: (actions) => {
        actions.historyBack();
      },
    },
    {
      id: "history-forward",
      label: "Forward",
      subtitle: "Undo a Back step",
      kbd: "]",
      disabledReason: "Nothing to go forward to",
      group: "commands",
      disabled: () => !canStepForward(),
      run: (actions) => {
        actions.historyForward();
      },
    },
    {
      id: "collapse-branch",
      label: "Collapse branch",
      subtitle: "Close the cluster around the selection — symbol → file → folder",
      kbd: "X",
      disabledReason: NEEDS_SELECTION,
      group: "commands",
      disabled: (s) => !s.selected,
      run: (actions) => actions.collapseBranch(),
    },
    {
      id: "collapse-to-file-level",
      label: "Collapse to file level",
      subtitle: "Close every expansion above file level — back to clean file arcs",
      kbd: "⇧X",
      group: "commands",
      disabled: () => false,
      run: (actions) => actions.collapseToFileLevel(),
    },
    {
      id: "clean-slate",
      label: "Clean slate",
      subtitle: "Collapse expansion, clear filters/lens/overlays, and reframe — destructive",
      group: "commands",
      disabled: () => false,
      run: (actions) => actions.resetView(),
    },
    {
      id: "start-tour",
      label: "Start guided tour",
      subtitle: "Cinematic flythrough: overview → modules → hub → hierarchy → entry",
      disabledReason: "Already touring",
      group: "commands",
      disabled: (s) => s.tour || !s.model,
      run: (actions) => actions.startTour(),
    },
    {
      id: "screenshot",
      label: "Screenshot",
      subtitle: "Capture a PNG of the current view",
      group: "commands",
      disabled: () => false,
      run: (_actions, _state, env) => env.screenshot(),
    },
    {
      id: "copy-link",
      label: "Copy link to this view",
      subtitle: "The node, the lens and every active overlay (?node&lens&overlays)",
      disabledReason: NEEDS_SELECTION,
      group: "commands",
      disabled: (s) => !s.selected,
      run: (_actions, _state, env) => env.copyLink(),
    },
    {
      id: "toggle-minimap",
      label: "Toggle map",
      subtitle: "Overview of the clusters currently on screen",
      kbd: "M",
      group: "commands",
      disabled: () => false,
      run: (_actions, _state, env) => env.toggleLayer("minimap"),
    },
    {
      id: "toggle-legend",
      label: "Toggle legend",
      subtitle: "What every color and line weight means",
      group: "commands",
      disabled: () => false,
      run: (_actions, _state, env) => env.toggleLayer("legend"),
    },
    {
      id: "toggle-filters",
      label: "Toggle filters",
      subtitle: "Symbol kinds, relationships, confidence, edge bundling",
      group: "commands",
      disabled: () => false,
      run: (_actions, _state, env) => env.toggleLayer("filters"),
    },
    {
      id: "toggle-help",
      label: "Keyboard shortcuts",
      subtitle: "The full keymap",
      kbd: "?",
      group: "commands",
      disabled: () => false,
      run: (_actions, _state, env) => env.toggleLayer("help"),
    },
    {
      id: "toggle-labels",
      label: "Toggle labels",
      subtitle: "Show or hide in-scene name labels",
      group: "commands",
      disabled: () => false,
      run: (actions) => actions.toggleLabels(),
    },
    {
      id: "toggle-drift",
      label: "Toggle idle drift",
      subtitle: "Gentle camera drift after a few seconds of no interaction",
      kbd: "D",
      group: "commands",
      disabled: () => false,
      run: (actions, s) => actions.setIdleDrift(!s.idleDrift),
    },
  ];
}

/** A lightweight, session-local "recently opened" entry — just enough to
 *  render a Recent row and re-open it without holding onto the full
 *  NodeRecord (which can carry a long semantic summary). */
export interface RecentEntry {
  id: string;
  name: string;
  kind: string;
  filePath: string;
}

/** Push `entry` to the front of `list`, de-duplicating by id (a re-opened
 *  node moves to the front rather than appearing twice) and capping at
 *  `cap` (default 8, per the brief). Pure — returns a new array. */
export function pushRecent(
  list: RecentEntry[],
  entry: RecentEntry,
  cap = 8,
): RecentEntry[] {
  return [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, cap);
}
