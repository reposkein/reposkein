import { useEffect, useMemo, useRef } from "react";
import { CameraControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import CameraControlsImpl from "camera-controls";
import { useStore } from "../state/store";
import { visibleClusters } from "../data/clientModel";

/** How long (ms) of no interaction before the gentle idle azimuth drift kicks
 *  in, and how fast it rotates (radians / second). */
const IDLE_AFTER_MS = 4000;
const DRIFT_RADIANS_PER_SEC = 0.05;
/** Padding factor applied to the fitted bounding sphere (~1.3 → some breathing
 *  room around the framed cluster). */
const FIT_PADDING = 1.3;

/** CameraControls (orbit/zoom/pan) with damping, exposed via a ref so the app
 *  can auto-fit to the visible nodes (design §6). Adds:
 *   - useFitToVisible: refit whenever the visible set changes (load / expand /
 *     collapse) or a star is framed, via fitToSphere(sphere, true).
 *   - idle drift: gentle automatic azimuth rotation after a few seconds of no
 *     interaction; pauses the instant the user touches the controls. */
export function Controls() {
  const controlsRef = useRef<CameraControlsImpl | null>(null);
  const store = useStore();
  const model = store.model;
  const { invalidate } = useThree();

  // Tracks the last interaction time so idle drift only runs when idle.
  const lastInteractionRef = useRef<number>(performance.now());

  // --- useFitToVisible -----------------------------------------------------
  // Compute the bounding sphere of the currently-visible node world-positions
  // and frame it. Runs on first data load AND after every expand/collapse/
  // select (driven by store.fitNonce).
  const reusable = useMemo(
    () => ({
      box: new THREE.Box3(),
      sphere: new THREE.Sphere(),
      pt: new THREE.Vector3(),
    }),
    []
  );

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || !model) return;

    // focusTarget (from search): fly to a specific node.
    if (store.focusTarget) {
      const clusterKey =
        model.clusterOfNode.get(store.focusTarget) ?? store.focusTarget;
      const idx = model.indexByKey.get(clusterKey);
      if (idx !== undefined) {
        const { sphere, pt } = reusable;
        pt.set(
          model.positions[idx * 3]!,
          model.positions[idx * 3 + 1]!,
          model.positions[idx * 3 + 2]!
        );
        sphere.set(pt, 60 * FIT_PADDING);
        void controls.fitToSphere(sphere, true);
        lastInteractionRef.current = performance.now();
        invalidate();
        return;
      }
    }

    // If a single star is selected, frame just that node; otherwise frame the
    // whole currently-visible set.
    let keys: string[];
    if (store.selected && model.clusterOfNode.has(store.selected)) {
      keys = [model.clusterOfNode.get(store.selected)!];
    } else if (store.selected && model.indexByKey.has(store.selected)) {
      keys = [store.selected];
    } else {
      keys = [...visibleClusters(model, store.expanded)];
    }

    const { box, sphere, pt } = reusable;
    box.makeEmpty();
    let any = false;
    for (const key of keys) {
      const idx = model.indexByKey.get(key);
      if (idx === undefined) continue;
      pt.set(
        model.positions[idx * 3]!,
        model.positions[idx * 3 + 1]!,
        model.positions[idx * 3 + 2]!
      );
      box.expandByPoint(pt);
      any = true;
    }
    if (!any) return;

    box.getBoundingSphere(sphere);
    // Guard against a zero-radius sphere (single node / coincident points).
    sphere.radius = Math.max(sphere.radius, 4) * FIT_PADDING;
    void controls.fitToSphere(sphere, true);
    lastInteractionRef.current = performance.now();
    invalidate();
    // store.fitNonce is the explicit refit trigger (bumped on load / expand /
    // collapse / select); the other reads are intentionally not deps.
  }, [store.fitNonce, model]);

  // --- idle drift ----------------------------------------------------------
  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;
    const now = performance.now();
    // Any active user interaction resets the idle timer.
    if (controls.active) {
      lastInteractionRef.current = now;
      return;
    }
    if (now - lastInteractionRef.current < IDLE_AFTER_MS) return;
    // Gentle azimuth-only orbit; no transition (per-frame) so it reads smooth.
    void controls.rotate(DRIFT_RADIANS_PER_SEC * delta, 0, false);
    invalidate();
  });

  return (
    <CameraControls
      ref={controlsRef}
      makeDefault
      smoothTime={0.3}
      minDistance={2}
      maxDistance={1200}
      onStart={() => {
        // A user-initiated drag/zoom/pan: reset the idle timer so drift pauses.
        lastInteractionRef.current = performance.now();
      }}
    />
  );
}
