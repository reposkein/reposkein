/** Camera-nearest cluster tracking (REP-18 status bar, CENTER breadcrumb
 *  fallback). scene/Controls.tsx already publishes the camera's orbit target
 *  every animation frame as a module-level variable (never React state — see
 *  that file's docstring). Re-deriving "nearest visible cluster" from that at
 *  frame rate would mean the status bar's breadcrumb re-renders 60x/sec while
 *  the user orbits; instead this module polls the target on a fixed interval
 *  (>= the design's 250ms throttle) and only publishes to its channel when
 *  the sampled target actually moved AND the nearest cluster actually changed
 *  — so a subscriber re-renders only on a real breadcrumb change, at most
 *  every THROTTLE_MS. */

import { createChannel, useChannelValue } from "../state/channel";
import { getCameraTarget } from "./Controls";
import { visibleClusters, type ClientModel } from "../data/clientModel";

export const CAMERA_NEAREST_THROTTLE_MS = 250;

const channel = createChannel<string | null>(null);

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function sameVec(a: Vec3 | null, b: Vec3 | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** The visible cluster whose seeded position is closest (squared Euclidean)
 *  to `target`. null when there is nothing visible (no model / empty tree —
 *  callers fall back to the repo root). Exported for direct unit testing. */
export function nearestVisibleCluster(
  model: ClientModel,
  expanded: Set<string>,
  target: Vec3,
): string | null {
  const visible = visibleClusters(model, expanded);
  let best: string | null = null;
  let bestDist = Infinity;
  for (const key of visible) {
    const idx = model.indexByKey.get(key);
    if (idx === undefined) continue;
    const dx = model.positions[idx * 3]! - target.x;
    const dy = model.positions[idx * 3 + 1]! - target.y;
    const dz = model.positions[idx * 3 + 2]! - target.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      best = key;
    }
  }
  return best;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let refCount = 0;
let lastSampledTarget: Vec3 | null = null;

/** Starts (idempotently — ref-counted) the throttled poll. Call from a
 *  `useEffect` in the one component that owns the breadcrumb; the returned
 *  cleanup stops the interval when the last subscriber unmounts. Reads
 *  `getModel`/`getExpanded` fresh on every tick (not captured once) so the
 *  poll always sees current state without needing to be restarted when the
 *  store changes. */
export function startCameraNearestTracking(
  getModel: () => ClientModel | null,
  getExpanded: () => Set<string>,
): () => void {
  refCount += 1;
  if (intervalId === null) {
    lastSampledTarget = null;
    intervalId = setInterval(() => {
      const model = getModel();
      const target = getCameraTarget();
      if (!model || !target) return;
      if (sameVec(lastSampledTarget, target)) return;
      lastSampledTarget = target;
      channel.set(nearestVisibleCluster(model, getExpanded(), target));
    }, CAMERA_NEAREST_THROTTLE_MS);
  }
  return () => {
    refCount -= 1;
    if (refCount <= 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
      refCount = 0;
    }
  };
}

/** The last-computed nearest-cluster key, or null before the first sample /
 *  when nothing is visible. Subscribing re-renders ONLY the caller. */
export function useCameraNearestClusterKey(): string | null {
  return useChannelValue(channel);
}

/** Test-only: resets the module singleton between test files. */
export function __resetCameraNearestForTests(): void {
  if (intervalId !== null) clearInterval(intervalId);
  intervalId = null;
  refCount = 0;
  lastSampledTarget = null;
  channel.set(null);
}
