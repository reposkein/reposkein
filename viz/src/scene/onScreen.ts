/** IS THAT POINT ON SCREEN? (Astrolabe V4 §5)
 *
 *  A neighbour hop should not move the camera when the neighbour is already in
 *  front of the reader. V3 flew on every hop, which meant the arrow keys yanked
 *  the view around a cluster the reader could already see whole — motion with
 *  no information in it, and under `frameloop="demand"` a wake-up too.
 *
 *  Pure math over plain numbers, deliberately: a real frustum test needs the
 *  camera's projection matrix, which only exists inside <Canvas>. This
 *  reconstructs the frustum from the same two things the minimap already
 *  publishes — the pose (`state/cameraPose.ts`) and the perspective parameters
 *  (`getCameraView`) — and shares `viewportHalfExtents`' perspective relation
 *  with `scene/minimap.ts`.
 *
 *  ASSUMPTION, stated because it is load-bearing: world up is +Y. That holds
 *  for the whole app — `CameraControls` is never rolled, and no code changes
 *  the up vector — so the basis can be rebuilt from position + target alone. If
 *  a rolled camera ever ships, this returns a wrong answer for nodes near the
 *  corners, and the consequence is a hop that flies when it needn't (or the
 *  reverse). It is deliberately never a correctness failure: the hop itself is
 *  decided by `data/navigate.ts`, and this only chooses whether to animate. */

import type { CameraPose } from "../state/cameraPose";
import type { CameraView } from "./Controls";

/** Fraction of the half-extent a point must be INSIDE to count as on screen.
 *  Below 1 on purpose: a node sitting one pixel from the edge is technically
 *  visible and practically not, and treating it as visible is how you get a
 *  selection the reader has to go hunting for. */
const INSET = 0.85;

function norm(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

const dot = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** True when the world point (x,y,z) is comfortably inside the current view.
 *
 *  UNKNOWN COUNTS AS OFF SCREEN: with no pose or no perspective params (the
 *  scene has not rendered a frame yet) the honest answer is "we don't know",
 *  and the safe behaviour for a caller deciding whether to fly is to fly. A
 *  wrong flight is a wasted animation; a wrongly-skipped one leaves the reader
 *  with a selection they cannot see. Pure. */
export function isPointOnScreen(
  pose: CameraPose | null,
  view: CameraView | null,
  x: number,
  y: number,
  z: number,
): boolean {
  if (!pose || !view) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  if (!Number.isFinite(view.fov) || !Number.isFinite(view.aspect)) return false;
  if (view.fov <= 0 || view.aspect <= 0) return false;

  const eye: [number, number, number] = [
    pose.position[0],
    pose.position[1],
    pose.position[2],
  ];
  const forward = norm([
    pose.target[0] - eye[0],
    pose.target[1] - eye[1],
    pose.target[2] - eye[2],
  ]);
  if (forward[0] === 0 && forward[1] === 0 && forward[2] === 0) return false;

  // Right/up basis from world up (+Y). Degenerate when looking straight up or
  // down, in which case fall back to world X as "right".
  let right = cross(forward, [0, 1, 0]);
  if (Math.hypot(right[0], right[1], right[2]) < 1e-6) right = [1, 0, 0];
  else right = norm(right);
  const up = norm(cross(right, forward));

  const v: [number, number, number] = [x - eye[0], y - eye[1], z - eye[2]];
  const depth = dot(v, forward);
  if (depth <= 0) return false; // behind the camera

  // The standard perspective relation, same as scene/minimap.viewportHalfExtents
  // but evaluated at THIS point's depth rather than at the orbit distance.
  const halfH = Math.tan((view.fov * Math.PI) / 360) * depth;
  const halfW = halfH * view.aspect;

  return (
    Math.abs(dot(v, right)) <= halfW * INSET && Math.abs(dot(v, up)) <= halfH * INSET
  );
}

/** The same question for a node id, resolving its layout slot first. Returns
 *  false (→ "fly") for a node with no slot, on the same "unknown means fly"
 *  principle. Pure. */
export function isNodeOnScreen(
  model: {
    positions: Float32Array;
    indexByKey: Map<string, number>;
    clusterOfNode: Map<string, string>;
  },
  nodeId: string,
  pose: CameraPose | null,
  view: CameraView | null,
): boolean {
  const key = model.clusterOfNode.get(nodeId) ?? nodeId;
  const idx = model.indexByKey.get(key);
  if (idx === undefined) return false;
  return isPointOnScreen(
    pose,
    view,
    model.positions[idx * 3]!,
    model.positions[idx * 3 + 1]!,
    model.positions[idx * 3 + 2]!,
  );
}
