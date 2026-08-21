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
 *  `panels/globalKeys.test.ts` checks the two against each other so a shortcut
 *  can't be implemented-but-undocumented or documented-but-dead. */

import type { Actions, State } from "../state/store";
import { pickNeighbor } from "../data/navigate";
import type { LayerId } from "./layerState";

export interface GlobalKeyEnv {
  /** Summon the ⌘K palette (panels/paletteOpenState.requestCommandPalette). */
  openPalette(): void;
  /** Summon or dismiss a layer (panels/layerState.toggleLayer). */
  toggleLayer(id: LayerId): void;
}

/** The minimal slice of a KeyboardEvent this needs — so a test can hand it a
 *  literal instead of constructing a real event with a real focused element.
 *  `target` is typed as `unknown` (narrowed in `isTyping`) rather than as a
 *  structural shape, because a real `KeyboardEvent.target` is `EventTarget`,
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

/** Handles one keydown. Returns true when the key was consumed.
 *
 *  Escape is the LAST resort in the Esc stack (palette > tour > layer > chip >
 *  here): every surface above consumes the event with
 *  `stopImmediatePropagation`, so reaching this function means nothing was open
 *  and Esc should back out one level of expansion. */
export function handleGlobalKey(
  e: GlobalKeyEventLike,
  state: State,
  actions: Actions,
  env: GlobalKeyEnv,
): boolean {
  // The guided tour owns the keyboard while it runs (its own handler exits it).
  if (state.tour) return false;

  const typing = isTyping(e);

  if (e.key === "Escape") {
    if (typing) return false;
    actions.collapseLevel();
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
    case "f":
    case "F":
      e.preventDefault();
      actions.resetView();
      return true;
  }

  // Neighbor hopping needs both a model and a selection to hop from.
  const model = state.model;
  if (!model || !state.selected) return false;
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
