/** SUMMONED LAYERS (Astrolabe V3 §2): the single coordinator for the four
 *  transient surfaces the viewer can call up — legend, minimap, filters, help.
 *
 *  WHY A SINGLETON AND NOT THE REDUCER. `statusBarOverlayState.ts` already
 *  established the pattern for the status bar's own popovers, for two reasons
 *  that apply here verbatim:
 *
 *   1. Perf. Every `useStore()` / `useStoreState()` consumer re-renders on any
 *      reducer transition — including the R3F scene components inside <Canvas>.
 *      Summoning the legend must not re-render the constellation. This module's
 *      subscribers are exactly the components that render chrome.
 *   2. Esc stacking. Handlers need to answer "is a layer open?" from a plain
 *      function during a keydown, without subscribing to that state.
 *
 *  EXCLUSIVITY IS STRUCTURAL, not a rule someone has to remember: the state is
 *  ONE nullable id, so opening a layer necessarily closes whatever was open.
 *  That is the fix for the user-visible V2 bug this phase exists to kill — the
 *  minimap and the legend were independent booleans, both defaulted true, both
 *  docked bottom-left, painting over each other on first load.
 *
 *  This replaces the reducer's old `showMinimap` / `showLegend` flags (removed
 *  in this phase). Nothing is lost: the palette reaches every layer through
 *  `PaletteEnv.toggleLayer` (state/commands.ts), and the status bar's Map /
 *  Legend / Filters / ? pills call straight into here.
 *
 *  Esc order (palette > tour > layer > chip) is enforced by the READERS:
 *   - `panels/LayerShell.tsx` defers to the palette and an active tour;
 *   - `panels/StatusBar.tsx`'s chip handler additionally defers to `openLayer`.
 *  See `panels/layerStack.test.tsx`. */

import { useSyncExternalStore } from "react";

export type LayerId = "legend" | "minimap" | "filters" | "help";

/** Display order — also the order the help overlay lists the toggles in. */
export const LAYER_IDS: readonly LayerId[] = ["minimap", "legend", "filters", "help"];

let openId: LayerId | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** The currently-summoned layer, or null. Readable from a keydown handler. */
export function openLayer(): LayerId | null {
  return openId;
}

export function isLayerOpen(id: LayerId): boolean {
  return openId === id;
}

/** Opens `id`, closing any other layer (exclusivity). */
export function showLayer(id: LayerId): void {
  if (openId === id) return;
  openId = id;
  emit();
}

/** Closes whatever layer is open. No-op when none is. Returns whether it
 *  actually closed something, so an Esc handler knows if it consumed the key. */
export function hideLayer(): boolean {
  if (openId === null) return false;
  openId = null;
  emit();
  return true;
}

/** Toggle: summons `id`, or dismisses it when it's already the open one. */
export function toggleLayer(id: LayerId): void {
  if (openId === id) hideLayer();
  else showLayer(id);
}

/** Subscribe to open/close transitions. Returns an unsubscribe. */
export function subscribeLayer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whatever layer was open when the guided tour started, parked so exiting the
 *  tour can put it back. Separate from `openId` (rather than a "suppressed"
 *  flag) so every reader — the Esc stack, the status-bar pills, LayerHost —
 *  agrees that NOTHING is open during cinematic mode, without any of them
 *  needing to know a tour is running. */
let stashed: LayerId | null = null;

/** Closes the open layer, remembering it. Called on tour entry: cinematic mode
 *  fades all chrome, and a legend sheet sitting through the flythrough is
 *  exactly what that mode exists to prevent. */
export function stashLayer(): void {
  stashed = openId;
  hideLayer();
}

/** Re-opens the layer `stashLayer` parked, if any, and forgets it. Called on
 *  tour exit, so the tour is a genuine round trip rather than a way to silently
 *  lose the panel you had open.
 *
 *  MERGE-AWARE (fix round 2 / REP-22 polish): a layer summoned from the
 *  palette WHILE the tour is running (nothing stops that — only Esc defers to
 *  the tour, opening one doesn't) leaves `openId` non-null at exit time. Blindly
 *  restoring the stash on top of that clobbered the viewer's own in-tour
 *  choice with whatever was open before the tour even started. The fix: only
 *  restore when nothing is currently open — an explicit toggle taken during
 *  the tour wins over the pre-tour stash. */
export function restoreStashedLayer(): void {
  const next = stashed;
  stashed = null;
  if (next && openId === null) showLayer(next);
}

/** Test/introspection hook: what `restoreStashedLayer` would re-open. */
export function stashedLayer(): LayerId | null {
  return stashed;
}

/** React binding. Only chrome subscribes — never anything inside <Canvas>. */
export function useOpenLayer(): LayerId | null {
  return useSyncExternalStore(subscribeLayer, openLayer, openLayer);
}

/** Test hook: drop back to "nothing open" without going through a component. */
export function resetLayers(): void {
  openId = null;
  stashed = null;
  emit();
}
