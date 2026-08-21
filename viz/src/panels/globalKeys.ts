/** The global key handler, lifted out of `routes/Root.tsx` (Astrolabe V3).
 *
 *  WHY IT MOVED. Root mounts the R3F <Canvas>, the postprocessing stack and the
 *  router hooks, so asserting "`/` opens the palette" used to mean standing up a
 *  WebGL harness. The bindings are the part that regresses — `/` pointed at a
 *  DOM id (`#reposkein-search`) that stopped existing when SearchPanel retired,
 *  which is precisely the class of breakage a test should catch — so they live
 *  here as a plain function over a plain event shape.
 *
 *  Side effects that aren't reducer transitions (summoning the palette, toggling
 *  a layer) arrive through `GlobalKeyEnv`, the same way `state/commands.ts` takes
 *  its screenshot/clipboard/layer effects. This module therefore imports no DOM
 *  and no `panels/` runtime — only the `LayerId` type, erased at compile time.
 *
 *  `data/keymap.ts` is the user-facing description of these same bindings;
 *  `panels/globalKeys.test.tsx` checks the two against each other so a shortcut
 *  can't be implemented-but-undocumented or documented-but-dead. */

import type { Actions, State } from "../state/store";
import { pickNeighbor } from "../data/navigate";
import type { LayerId } from "./layerState";

export interface GlobalKeyEnv {
  /** Summon the ⌘K palette (panels/paletteOpenState.requestCommandPalette). */
  openPalette(): void;
  /** Summon or dismiss a layer (panels/layerState.toggleLayer). */
  toggleLayer(id: LayerId): void;
  /** Is the ⌘K palette on screen (panels/paletteOpenState.isCommandPaletteOpen)?
   *
   *  The palette is MODAL, and it is the top of the Esc stack — but unlike the
   *  summoned layers and the status bar's chip handler, it cannot announce that
   *  by consuming the event: its Esc lives in a React `onKeyDown` on the dialog,
   *  and a synthetic event bubbles all the way to the window listener that calls
   *  this function. Through V3 that meant closing the palette with Esc ALSO ran
   *  the global Esc step (then: collapse a level — so dismissing the palette
   *  silently rearranged the scene). Asking the singleton is what makes "the
   *  palette wins" true rather than aspirational. */
  paletteOpen(): boolean;
}

/** Spread onto any widget that binds Arrow / Home / End / Tab FOR ITSELF, to
 *  keep this module's neighbor-hop off those keys while focus is inside it.
 *
 *  This exists because of a real double-fire: the Inspector's incident-edges
 *  table uses a roving tabindex, so ArrowDown on a focused `<tr>` moved the
 *  roving focus one row — and then bubbled to Root's window listener, which
 *  read it as "hop to the next neighbor" and jumped the SELECTION to an
 *  unrelated node. `isTyping` couldn't catch it: a focused `<tr>` is not an
 *  input, a textarea, or contenteditable.
 *
 *  Defense in depth, deliberately both halves:
 *   - the widget calls `stopPropagation` so the event never reaches window;
 *   - this attribute makes the global handler decline even if it does (a future
 *     widget that forgets to stop propagation degrades to "no hop", not to
 *     "silently moves the selection").
 *
 *  Spread as props rather than typed as a literal in two places so the
 *  attribute name can't drift between producer and consumer. */
export const keyScopeProps = { "data-key-scope": "" } as const;

const KEY_SCOPE_SELECTOR = "[data-key-scope]";

/** The minimal slice of a KeyboardEvent this needs — so a test can hand it a
 *  literal instead of constructing a real event with a real focused element.
 *  `target` is typed as `unknown` (narrowed by the helpers below) rather than as
 *  a structural shape, because a real `KeyboardEvent.target` is `EventTarget`,
 *  which shares no declared properties with an element-shaped literal and so
 *  wouldn't be assignable to one. */
export interface GlobalKeyEventLike {
  key: string;
  shiftKey?: boolean;
  target?: unknown;
  preventDefault(): void;
}

/** True when focus is in a text-entry surface, where the app must not hijack
 *  ordinary letters. Esc is deliberately still allowed to pass (a field's own
 *  handler consumes it first when it wants to). */
function isTyping(e: GlobalKeyEventLike): boolean {
  const t = e.target as { tagName?: unknown; isContentEditable?: unknown } | null | undefined;
  if (!t) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable === true;
}

/** True when focus sits inside a widget that declared `keyScopeProps`. */
function inKeyScope(e: GlobalKeyEventLike): boolean {
  const t = e.target as { closest?: (selector: string) => unknown } | null | undefined;
  if (!t || typeof t.closest !== "function") return false;
  return t.closest(KEY_SCOPE_SELECTOR) != null;
}

/** Handles one keydown. Returns true when the key was consumed.
 *
 *  Escape is the LAST resort in the Esc stack (palette > tour > summoned layer >
 *  topmost mode chip > here): every surface above consumes the event with
 *  `stopImmediatePropagation`, so reaching this function means nothing was open
 *  and Esc should clear the selection.
 *
 *  ESC NEVER COLLAPSES (Astrolabe V4 §1). V3's final step was
 *  `collapseLevel()` — shut the globally-deepest expanded cluster — which made
 *  Esc a destructive, non-obvious edit to the scene at the exact moment the
 *  reader was trying to back out of something. The final step is now DESELECT,
 *  and when there is nothing selected either, Esc does nothing at all: the
 *  bottom of a back-out stack should be a no-op, not a surprise. LOD collapse
 *  is reachable only through `x` / `⇧x`, a breadcrumb click, or a cluster
 *  click — all three of which name what they are about to close. */
export function handleGlobalKey(
  e: GlobalKeyEventLike,
  state: State,
  actions: Actions,
  env: GlobalKeyEnv,
): boolean {
  // The guided tour owns the keyboard while it runs (its own handler exits it).
  if (state.tour) return false;
  // The palette is modal AND cannot consume the event itself — see
  // `GlobalKeyEnv.paletteOpen`. Nothing global fires behind it.
  if (env.paletteOpen()) return false;

  const typing = isTyping(e);

  if (e.key === "Escape") {
    if (typing) return false;
    if (!state.selected) return false; // bottom of the stack: a genuine no-op
    actions.select(null);
    return true;
  }
  if (typing) return false;

  switch (e.key) {
    case "/":
      e.preventDefault();
      env.openPalette();
      return true;
    case "?":
      e.preventDefault();
      env.toggleLayer("help");
      return true;
    case "m":
    case "M":
      e.preventDefault();
      env.toggleLayer("minimap");
      return true;
    // `f` FRAMES, and only frames (V4 §6). It used to call `resetView()` —
    // which is Clean slate: it wiped the lens, the filters, every overlay and
    // the whole expansion tree. A key labelled "Frame all" in the keymap and
    // in the status bar's Frame pill must not be the most destructive command
    // in the app. `requestFit` is what the pill and the palette row already do.
    case "f":
    case "F":
      e.preventDefault();
      actions.requestFit();
      return true;
    case "d":
    case "D":
      e.preventDefault();
      actions.setIdleDrift(!state.idleDrift);
      return true;
    // SCOPED COLLAPSE (V4 §2). LOD collapse happens ONLY here, on a breadcrumb
    // click, or on a cluster click — never on Esc and never on a misclick.
    case "x":
    case "X":
      e.preventDefault();
      if (e.shiftKey || e.key === "X") actions.collapseToFileLevel();
      else actions.collapseBranch();
      return true;
    // VIEW HISTORY (V4 §4). Returns whether it actually moved, so the key is
    // left UNCONSUMED at either end of the stack — the browser's own back /
    // forward gesture is not something to swallow silently.
    case "[":
      e.preventDefault();
      return actions.historyBack();
    case "]":
      e.preventDefault();
      return actions.historyForward();
  }

  // Neighbor hopping needs both a model and a selection to hop from.
  const model = state.model;
  if (!model || !state.selected) return false;
  // …and must never fight a widget that binds these keys itself. See
  // `keyScopeProps` for the double-fire this prevents.
  if (inKeyScope(e)) return false;
  let dir: "next" | "prev" | null = null;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") dir = "next";
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") dir = "prev";
  else if (e.key === "Tab") dir = e.shiftKey ? "prev" : "next";
  if (!dir) return false;
  e.preventDefault();
  const next = pickNeighbor(model.drawEdges, state.selected, dir);
  if (!next) return true; // consumed: we handled the hop, there was nowhere to go
  actions.revealAndSelect(next, { fly: true });
  return true;
}
