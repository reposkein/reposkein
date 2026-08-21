import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useStoreState } from "../state/store";
import { representativeFor, visibleClusters } from "../data/clientModel";

/** How long the trail stays on screen, in ms (V4 §5: "400ms trail line"). */
const TRAIL_MS = 400;

/** HOP TRAIL (Astrolabe V4 §5): a brief line from the node you hopped FROM to
 *  the one you landed on.
 *
 *  WHY IT EXISTS. An arrow hop changes the selection instantly, and — now that
 *  a hop to an on-screen neighbour deliberately does NOT move the camera — the
 *  only feedback would be a highlight moving between two stars several hundred
 *  pixels apart. Readers lose which star was theirs. A 400ms line says "you
 *  came from there" without moving anything.
 *
 *  MOTION DISCIPLINE. Two things this must not do:
 *
 *   - It must not keep the GPU awake. The scene runs `frameloop="demand"`, so
 *     the fade calls `invalidate()` for exactly as long as the trail is alive
 *     and then stops, leaving the renderer idle again. This is the reason the
 *     component unmounts its geometry rather than holding a zero-opacity line.
 *   - It must respect `prefers-reduced-motion`. Under that preference the
 *     trail is simply not drawn: it is pure decoration, and unlike the layer
 *     animations there is no "final state" worth snapping to.
 *
 *  Endpoints are the DEEPEST VISIBLE representatives of the two nodes, not the
 *  nodes themselves. Hopping into a collapsed directory selects a symbol whose
 *  own layout slot is inside a cluster nobody can see; drawing to that slot
 *  would put the line's end in empty space. */
export function HopTrail() {
  const store = useStoreState();
  const model = store.model;
  const hop = store.lastHop;
  const hopNonce = store.hopNonce;
  const { invalidate } = useThree();

  const reduceMotion = usePrefersReducedMotion();

  // The nonce this trail is animating. Restarting on the nonce (not on `hop`)
  // is what makes hopping the same pair twice re-draw.
  const [liveNonce, setLiveNonce] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (hopNonce === 0 || reduceMotion) return;
    startedAt.current = performance.now();
    setLiveNonce(hopNonce);
    invalidate();
  }, [hopNonce, reduceMotion, invalidate]);

  const geometry = useMemo(() => {
    if (!model || !hop || liveNonce !== hopNonce || reduceMotion) return null;
    const visible = visibleClusters(model, store.expanded);
    const a = representativeFor(model, hop.from, visible);
    const b = representativeFor(model, hop.to, visible);
    if (!a || !b || a === b) return null;
    const ia = model.indexByKey.get(a);
    const ib = model.indexByKey.get(b);
    if (ia === undefined || ib === undefined) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          model.positions[ia * 3]!,
          model.positions[ia * 3 + 1]!,
          model.positions[ia * 3 + 2]!,
          model.positions[ib * 3]!,
          model.positions[ib * 3 + 1]!,
          model.positions[ib * 3 + 2]!,
        ],
        3,
      ),
    );
    return geo;
  }, [model, hop, liveNonce, hopNonce, reduceMotion, store.expanded]);

  // r3f does not free a manually-`new`'d geometry; without this every hop leaks
  // a GPU buffer.
  useEffect(() => {
    const g = geometry;
    return () => g?.dispose();
  }, [geometry]);

  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: 0xffc76b, // brand amber — the same "you did this" accent as chips
        transparent: true,
        opacity: 1,
        depthWrite: false,
      }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);

  const done = useRef(false);
  useFrame(() => {
    if (!geometry) return;
    const elapsed = performance.now() - startedAt.current;
    if (elapsed >= TRAIL_MS) {
      // Unmount the line by clearing the nonce we're animating, ONCE — then stop
      // invalidating so `frameloop="demand"` can put the renderer back to sleep.
      if (!done.current) {
        done.current = true;
        setLiveNonce(0);
        invalidate();
      }
      return;
    }
    done.current = false;
    // Ease-out fade: the line is brightest at the moment of the hop, which is
    // when the reader's eye is still on the node they left.
    const t = elapsed / TRAIL_MS;
    material.opacity = (1 - t) * (1 - t);
    invalidate();
  });

  if (!geometry) return null;
  return <lineSegments geometry={geometry} material={material} renderOrder={12} />;
}

/** `prefers-reduced-motion: reduce`, as a boolean that tracks changes.
 *
 *  Chrome elsewhere expresses this with Tailwind's `motion-reduce:` variants,
 *  which is the right tool for CSS. Inside <Canvas> there is no CSS, so the
 *  preference has to be read in JS. Guarded for environments without
 *  `matchMedia` (jsdom without the shim) rather than assumed present. */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduce;
}
