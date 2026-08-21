/** The camera's exact pose, as PLAIN NUMBERS (Astrolabe V4 §4).
 *
 *  WHY THIS MODULE EXISTS. View history restores three things: the selection,
 *  the expansion set, and the camera pose. The first two live in the reducer.
 *  The third cannot: the authoritative pose lives inside `camera-controls`,
 *  mutated every frame, inside <Canvas>. So the reducer holds a *request* to be
 *  at a pose (`poseTarget` + `poseNonce`) and this module is the seam that
 *  `scene/Controls.tsx` publishes the current pose through.
 *
 *  It is in `state/` rather than `scene/` deliberately, and holds no three.js
 *  types. `state/store.tsx` needs to READ the pose when it records a history
 *  entry; if the pose lived in `scene/Controls.tsx` that would be a store →
 *  scene import, and Controls already imports the store — a cycle. With the
 *  data here, both point inwards: scene → state, and nothing points back.
 *
 *  A pose is deliberately NOT a bounding sphere. Restoring history must
 *  reproduce the frame the reader was looking at, not re-derive a fit from the
 *  visible set — `fitToSphere` would land somewhere plausible but different,
 *  which is exactly the "Back didn't take me back" feeling this replaces. */

/** Camera position + orbit target in world space. Immutable by convention:
 *  publishers hand over a fresh object, history holds the reference. */
export interface CameraPose {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

let current: CameraPose | null = null;

/** Publish the live pose. Called from Controls' per-frame loop; cheap enough
 *  that it does not need throttling (one allocation of two 3-tuples). */
export function publishCameraPose(pose: CameraPose): void {
  current = pose;
}

/** The pose as of the last rendered frame, or null before the scene mounts.
 *  Safe to call from a keydown handler or an action wrapper. */
export function getCameraPose(): CameraPose | null {
  return current;
}

/** Test/unmount hook: forget the pose. Controls calls this on teardown so a
 *  remounted scene never restores into a stale frame. */
export function resetCameraPose(): void {
  current = null;
}

/** Structural equality, for tests and for skipping a redundant restore. */
export function samePose(a: CameraPose | null, b: CameraPose | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.position[i] !== b.position[i]) return false;
    if (a.target[i] !== b.target[i]) return false;
  }
  return true;
}
