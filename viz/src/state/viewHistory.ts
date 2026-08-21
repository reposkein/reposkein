/** VIEW HISTORY (Astrolabe V4 §4): `[` and `]` over the last 50 views.
 *
 *  A "view" is the triple a reader would call "where I was": what was selected,
 *  what was expanded, and where the camera was pointing. Navigation in this
 *  viewer is cheap and one-way — a palette jump, an arrow hop, a breadcrumb
 *  click and a cluster expand all move you somewhere without leaving a trail —
 *  so the one gesture the app had no answer for was "put that back".
 *
 *  WHY A SINGLETON AND NOT THE REDUCER. Same two reasons as
 *  `panels/layerState.ts`, plus one specific to this:
 *
 *   1. A history entry contains the camera pose, which is NOT reducer state —
 *      it is read from `state/cameraPose.ts` at the moment of the push. Putting
 *      the stack in the reducer would mean either a reducer that reads a
 *      singleton (impure) or a `pose` field the reducer would have to keep in
 *      sync with a value it does not own.
 *   2. Nothing renders the stack. `[` / `]` and two palette rows read it; no
 *      component subscribes, so a push must not re-render the scene.
 *
 *  THE MODEL IS THE BROWSER'S, deliberately: two stacks, not a cursor into one
 *  array. `push` clears the forward stack (a new navigation abandons the branch
 *  you had walked back from), `back` moves the CURRENT view onto forward, and
 *  `forward` moves it back. The current view is never itself in a stack — the
 *  caller passes it in — which is what keeps "back then forward" an exact
 *  round trip rather than an off-by-one.
 *
 *  Pure functions over module state, no React, no DOM: `viewHistory.test.ts`
 *  drives the whole thing with plain objects. */

import { samePose, type CameraPose } from "./cameraPose";

/** One remembered view. `expanded` and `pose` are held BY REFERENCE and never
 *  mutated — the reducer already treats `expanded` as an owned immutable value
 *  (every transition builds a new Set), so snapshotting is free and a restore
 *  can hand the very same object back. */
export interface ViewSnapshot {
  selected: string | null;
  expanded: Set<string>;
  /** Null when the scene had not rendered a frame yet (cold deep link). */
  pose: CameraPose | null;
}

/** How many steps back the reader can walk. Bounded because a snapshot pins an
 *  expansion Set, and an unbounded stack would quietly retain every expansion
 *  state of a long session. */
export const HISTORY_CAP = 50;

let back: ViewSnapshot[] = [];
let forward: ViewSnapshot[] = [];

/** Structural sameness for two snapshots: same selection, same expansion
 *  CONTENTS, same camera pose.
 *
 *  Contents, not reference. Reference would have been exact if every reducer
 *  transition allocated a new `expanded` only when the expansion really moved,
 *  but `expandToReveal` returns a fresh Set unconditionally — so a repeated
 *  reveal of an already-revealed node produces a new Set with identical members
 *  and would slip past a reference check. Comparing contents is also the honest
 *  rule for this question: if all three fields match, there is nothing for `[`
 *  to go back TO. The sets hold tens of keys, so the cost is nil. */
function sameSnapshot(a: ViewSnapshot, b: ViewSnapshot): boolean {
  if (a.selected !== b.selected) return false;
  if (!samePose(a.pose, b.pose)) return false;
  if (a.expanded === b.expanded) return true;
  if (a.expanded.size !== b.expanded.size) return false;
  for (const key of a.expanded) if (!b.expanded.has(key)) return false;
  return true;
}

/** Record `snapshot` as a view the reader can return to, and abandon any
 *  forward branch. Called with the PRE-navigation view: pushing happens on the
 *  way out of a view, not on the way into one.
 *
 *  A push identical to the top of the stack is DROPPED (fix round 1, `I2`).
 *  Callers guard the conditional cases themselves — see `record` in
 *  `state/store.tsx` — but this is the general net: a run of identical entries
 *  is never useful (`[` would step through views that all look the same) and
 *  under `HISTORY_CAP` it evicts the trail the reader actually wants. */
export function pushView(snapshot: ViewSnapshot): void {
  const top = back[back.length - 1];
  if (top && sameSnapshot(top, snapshot)) return;
  back.push(snapshot);
  if (back.length > HISTORY_CAP) back = back.slice(back.length - HISTORY_CAP);
  forward = [];
}

/** Step back one view. `current` is where we are now, and is pushed onto the
 *  forward stack so `]` returns to it exactly. Null when there is nowhere to go
 *  — the caller must then leave the key unconsumed. */
export function stepBack(current: ViewSnapshot): ViewSnapshot | null {
  const previous = back.pop();
  if (!previous) return null;
  forward.push(current);
  return previous;
}

/** Step forward one view, mirroring `stepBack`. */
export function stepForward(current: ViewSnapshot): ViewSnapshot | null {
  const next = forward.pop();
  if (!next) return null;
  back.push(current);
  return next;
}

export function canStepBack(): boolean {
  return back.length > 0;
}

export function canStepForward(): boolean {
  return forward.length > 0;
}

/** Depths, for tests and for the palette's subtitles. */
export function historyDepth(): { back: number; forward: number } {
  return { back: back.length, forward: forward.length };
}

/** Forget everything. Called by every `cleanSlate` path (Clean slate, Reset
 *  expansion, tour entry) — see the DECISION note in `state/store.tsx`: a clean
 *  slate is a fresh start, so walking `[` back into a pre-reset view would
 *  resurrect exactly the expansion and overlays the reader just asked to be rid
 *  of. Also the test hook. */
export function resetViewHistory(): void {
  back = [];
  forward = [];
}
