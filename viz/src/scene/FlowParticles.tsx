import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../state/store";
import {
  bundleEdges,
  filterDrawEdges,
  representativeFor,
  visibleClusters,
  type EdgeBundle,
} from "../data/clientModel";
import { edgeColor } from "./encoding";
import { allocateParticles } from "./flow";

/** Hard cap on total flow particles. Chosen so the worst case stays a few
 *  thousand even on the ~10k-edge design target (one additive Points draw). */
const PARTICLE_BUDGET = 3000;
/** Fraction of an edge a particle traverses per second (subtle drift). */
const FLOW_SPEED = 0.32;
/** Particle point size (small + additive so the flow reads as a gentle pulse). */
const PARTICLE_SIZE = 1.7;
/** Color/alpha multiplier — kept low so the motion is subtle by default. */
const PARTICLE_GAIN = 0.55;

/** Edge-direction flow particles (design §P1): a SINGLE additive THREE.Points
 *  buffer of small pulses that travel from each visible bundle's SOURCE (caller)
 *  toward its TARGET (callee), conveying direction + life. The static per-pair
 *  endpoints + colors are precomputed; useFrame advances a shared phase and
 *  lerps every particle's world position. Honors the SAME edge filters/lenses
 *  as EdgeLines (no particles on hidden edges) and the neighborhood-focus dim.
 *
 *  Budget-capped + sampled (see allocateParticles): high-traffic bundles and
 *  bundles incident to the selected/hovered node are prioritized; when the
 *  graph is large we sample the rest so the buffer never blows the cap. */
export function FlowParticles() {
  const store = useStore();
  const model = store.model!;

  const { geometry, fromArr, toArr, phaseArr, count } = useMemo(() => {
    const visible = visibleClusters(model, store.expanded);

    // Same gate as EdgeLines: hidden edge types / low confidence / audit mode
    // remove their particles too.
    const filteredModel = filterDrawEdges(model, {
      edgeTypes: store.filters.edgeTypes,
      minConfidence: store.filters.minConfidence,
      audit: store.audit,
    });
    const bundles = bundleEdges(filteredModel, visible);

    // Priority bundles: incident to the selected or hovered node's visible rep.
    const accentKeys = new Set<string>();
    const selRep = store.selected ? representativeFor(model, store.selected, visible) : null;
    const hovRep = store.hovered ? representativeFor(model, store.hovered, visible) : null;
    if (selRep) accentKeys.add(selRep);
    if (hovRep) accentKeys.add(hovRep);
    const isPriority =
      accentKeys.size > 0
        ? (b: EdgeBundle) => accentKeys.has(b.srcKey) || accentKeys.has(b.dstKey)
        : undefined;

    const { particles } = allocateParticles(bundles, PARTICLE_BUDGET, isPriority);
    const n = particles.length;

    const fromArr = new Float32Array(n * 3);
    const toArr = new Float32Array(n * 3);
    const phaseArr = new Float32Array(n);
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);

    let w = 0;
    for (let p = 0; p < n; p++) {
      const part = particles[p]!;
      const b = bundles[part.bundleIndex]!;
      const si = model.indexByKey.get(b.srcKey);
      const di = model.indexByKey.get(b.dstKey);
      if (si === undefined || di === undefined) continue;
      fromArr[w * 3] = model.positions[si * 3]!;
      fromArr[w * 3 + 1] = model.positions[si * 3 + 1]!;
      fromArr[w * 3 + 2] = model.positions[si * 3 + 2]!;
      toArr[w * 3] = model.positions[di * 3]!;
      toArr[w * 3 + 1] = model.positions[di * 3 + 1]!;
      toArr[w * 3 + 2] = model.positions[di * 3 + 2]!;
      // Start at the source so the first frame isn't blank.
      positions[w * 3] = fromArr[w * 3]!;
      positions[w * 3 + 1] = fromArr[w * 3 + 1]!;
      positions[w * 3 + 2] = fromArr[w * 3 + 2]!;
      phaseArr[w] = part.phase;
      const [r, g, bl] = edgeColor(b.dominantType);
      // Accent (selected/hovered) particles glow brighter; the rest stay subtle.
      const incident = accentKeys.size > 0 && (accentKeys.has(b.srcKey) || accentKeys.has(b.dstKey));
      const gain = PARTICLE_GAIN * (incident ? 2.0 : 1.0);
      colors[w * 3] = r * gain;
      colors[w * 3 + 1] = g * gain;
      colors[w * 3 + 2] = bl * gain;
      w++;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setDrawRange(0, w);
    return { geometry: geo, fromArr, toArr, phaseArr, count: w };
  }, [
    model,
    store.expanded,
    store.filters,
    store.audit,
    store.selected,
    store.hovered,
  ]);

  const pointsRef = useRef<THREE.Points>(null);

  useFrame(({ clock, invalidate }) => {
    const pts = pointsRef.current;
    if (!pts || count === 0) return;
    const posAttr = pts.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const arr = posAttr.array as Float32Array;
    const base = clock.elapsedTime * FLOW_SPEED;
    for (let i = 0; i < count; i++) {
      // t in [0,1): each particle's phase offset spreads pulses along the edge.
      const t = (base + phaseArr[i]!) % 1;
      const fx = fromArr[i * 3]!;
      const fy = fromArr[i * 3 + 1]!;
      const fz = fromArr[i * 3 + 2]!;
      arr[i * 3] = fx + (toArr[i * 3]! - fx) * t;
      arr[i * 3 + 1] = fy + (toArr[i * 3 + 1]! - fy) * t;
      arr[i * 3 + 2] = fz + (toArr[i * 3 + 2]! - fz) * t;
    }
    posAttr.needsUpdate = true;
    invalidate(); // continuous animation: keep the frame loop alive
  });

  if (count === 0) return null;

  return (
    <points ref={pointsRef} geometry={geometry} raycast={() => null}>
      <pointsMaterial
        size={PARTICLE_SIZE}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.9}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}
