/** MISCLICK SAFETY (Astrolabe V4 §3) — what a click on empty space does.
 *
 *  This is three lines of logic that lives in its own module for the same
 *  reason `panels/globalKeys.ts` does: the behaviour is the part that
 *  regresses, and the only other home for it is Root's `<Canvas>` prop, which
 *  cannot be asserted without standing up a WebGL harness.
 *
 *  V3 collapsed one LOD level here. A pointer that misses a star by two pixels
 *  is the single most common accidental gesture in the viewer, and it silently
 *  rearranged the scene — the reader's mental model of "what is expanded" broke
 *  without them doing anything they meant to do. It now DESELECTS, which is
 *  cheap, visible, and undone by clicking the star again. It never collapses,
 *  and (because `select(null)` does not bump fitNonce — see the reducer) it
 *  never moves the camera either. */

import type { Actions } from "../state/store";

/** The minimal slice of a pointer event this needs, so a test can hand it a
 *  literal instead of synthesising an R3F pointer-missed event. */
export interface PointerMissedLike {
  /** 0 = primary/left. Middle and right clicks are orbit/pan gestures. */
  button: number;
}

/** Handles a click that hit no object. Returns whether it was consumed. */
export function handlePointerMissed(
  e: PointerMissedLike,
  actions: Pick<Actions, "select">,
): boolean {
  if (e.button !== 0) return false;
  actions.select(null);
  return true;
}
