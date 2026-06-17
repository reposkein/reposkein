import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../state/store";
import {
  selectVisibleEdges,
  repOf,
  focusRepsOf,
  type EdgeBundle,
} from "../data/clientModel";
import { edgeColor } from "./encoding";
import { sampleBundleCurve, FLOW_SAMPLES } from "./bundleGeometry";
import { allocateParticles } from "./flow";

/** Hard cap on total flow particles. Chosen so the worst case stays a few
 *  thousand even on the ~10k-edge design target (one additive Points draw). */
const PARTICLE_BUDGET = 3000;
/** Fraction of an edge a particle traverses per second (subtle drift). */
const FLOW_SPEED = 0.32;
/** Particle point size in WORLD units (sizeAttenuation). Small + round + additive
 *  so the flow reads as a gentle pulse, clearly smaller than the star nodes. */
const PARTICLE_SIZE = 0.8;
/** Color/alpha multiplier — kept low so the motion is subtle by default. */
const PARTICLE_GAIN = 0.55;
/** Points per sampled bundle curve (FLOW_SAMPLES segments). */
const CURVE_PTS = FLOW_SAMPLES + 1;

/** A soft radial-gradient sprite so particles render as round glowing pulses
 *  (a bare pointsMaterial draws hard squares). Built once, module-level. */
let SPRITE: THREE.CanvasTexture | null = null;
function softSprite(): THREE.CanvasTexture {
  if (SPRITE) return SPRITE;
  const s = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  SPRITE = new THREE.CanvasTexture(canvas);
  return SPRITE;
}

/** Edge-direction flow particles (design §P1 / §6): a SINGLE additive
 *  THREE.Points buffer of small pulses that travel from each visible bundle's
 *  SOURCE (caller) toward its TARGET (callee). Shares the SAME selectVisibleEdges
 *  pass as EdgeLines (one roll-up, no latent drift) and now rides the SAME
 *  Holten-bundled curve as the rendered arc (curve-following), so at the default
 *  bundleBeta=0.85 the pulses hug the arcs instead of floating off the chord.
 *
 *  Per used bundle we precompute a sampled curve polyline (CURVE_PTS points);
 *  useFrame advances a shared phase and walks each particle along its bundle's
 *  polyline (allocation-light: only reads the precomputed arrays). */
export function FlowParticles() {
  const store = useStore();
  const model = store.model!;

  const { geometry, curves, curveBase, phaseArr, count } = useMemo(() => {
    // STAGE A — same selection as EdgeLines (with the same activeNodes).
    const activeNodes = [store.selected, store.hovered, ...(store.focus?.nodes ?? [])].filter(
      Boolean,
    ) as string[];
    const { bundles, visible } = selectVisibleEdges(model, {
      expanded: store.expanded,
      filters: {
        edgeTypes: store.filters.edgeTypes,
        minConfidence: store.filters.minConfidence,
        audit: store.audit,
      },
      activeNodes,
    });

    // Neighborhood focus: only animate edges WHOLLY inside the focused set.
    let active = bundles;
    if (store.focus) {
      const focusReps = focusRepsOf(model, store.focus, visible);
      if (focusReps) {
        active = bundles.filter((b) => focusReps.has(b.srcKey) && focusReps.has(b.dstKey));
      }
    }

    // Priority bundles: incident to the selected or hovered node's visible rep.
    const accentKeys = new Set<string>();
    const selRep = store.selected ? repOf(model, store.selected, visible) : null;
    const hovRep = store.hovered ? repOf(model, store.hovered, visible) : null;
    if (selRep) accentKeys.add(selRep);
    if (hovRep) accentKeys.add(hovRep);
    const isPriority =
      accentKeys.size > 0
        ? (b: EdgeBundle) => accentKeys.has(b.srcKey) || accentKeys.has(b.dstKey)
        : undefined;

    const { particles } = allocateParticles(active, PARTICLE_BUDGET, isPriority);
    const n = particles.length;

    // Cache a sampled curve per USED bundle (dedup across its particles).
    const curveOffsetByBundle = new Map<number, number>();
    const curves = new Float32Array(n * CURVE_PTS * 3); // worst case: every particle unique
    let curveCursor = 0; // in points

    const phaseArr = new Float32Array(n);
    const curveBase = new Int32Array(n); // per-particle: starting point index into `curves`
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);

    let w = 0;
    for (let p = 0; p < n; p++) {
      const part = particles[p]!;
      const b = active[part.bundleIndex]!;
      if (!model.indexByKey.has(b.srcKey) || !model.indexByKey.has(b.dstKey)) continue;

      // Sample (or reuse) this bundle's curve into the shared buffer.
      let off = curveOffsetByBundle.get(part.bundleIndex);
      if (off === undefined) {
        const written = sampleBundleCurve(
          model,
          b.srcKey,
          b.dstKey,
          store.bundleBeta,
          curves,
          curveCursor * 3,
        );
        if (written === 0) continue; // undrawable bundle → skip its particles
        off = curveCursor;
        curveOffsetByBundle.set(part.bundleIndex, off);
        curveCursor += written;
      }

      curveBase[w] = off; // point index of this bundle's curve start
      // Start at the source (curve point 0) so the first frame isn't blank.
      positions[w * 3] = curves[off * 3]!;
      positions[w * 3 + 1] = curves[off * 3 + 1]!;
      positions[w * 3 + 2] = curves[off * 3 + 2]!;
      phaseArr[w] = part.phase;
      const [r, g, bl] = edgeColor(b.dominantType);
      const incident =
        accentKeys.size > 0 && (accentKeys.has(b.srcKey) || accentKeys.has(b.dstKey));
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
    return { geometry: geo, curves, curveBase, phaseArr, count: w };
  }, [
    model,
    store.expanded,
    store.filters,
    store.audit,
    store.focus,
    store.selected,
    store.hovered,
    store.bundleBeta,
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
      // t in [0,1): each particle's phase offset spreads pulses along the curve.
      const t = (base + phaseArr[i]!) % 1;
      // Walk the precomputed CURVE_PTS-point polyline of this particle's bundle.
      const cb = curveBase[i]!; // first curve point index
      const f = t * FLOW_SAMPLES; // [0, FLOW_SAMPLES]
      let seg = f | 0;
      if (seg >= FLOW_SAMPLES) seg = FLOW_SAMPLES - 1;
      const lt = f - seg;
      const a = (cb + seg) * 3;
      const bx = (cb + seg + 1) * 3;
      arr[i * 3] = curves[a]! + (curves[bx]! - curves[a]!) * lt;
      arr[i * 3 + 1] = curves[a + 1]! + (curves[bx + 1]! - curves[a + 1]!) * lt;
      arr[i * 3 + 2] = curves[a + 2]! + (curves[bx + 2]! - curves[a + 2]!) * lt;
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
        map={softSprite()}
        vertexColors
        transparent
        opacity={0.85}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}
