import { useEffect, useMemo, useRef } from "react";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../state/store";
import { representativeFor, visibleClusters } from "../data/clientModel";
import { nodeColor, nodeSize } from "./encoding";
import { isTestNode } from "../data/classify";
import { TYPE_EMPHASIS_KINDS } from "../data/lens";
import type { RGB } from "./encoding";

/** Accent colors for the impact overlay (design: impacted vs covering tests). */
const IMPACT_ACCENT: RGB = [1.0, 0.42, 0.32]; // warm coral — impacted callers
const COVERING_ACCENT: RGB = [0.45, 1.0, 0.55]; // green — covering tests
/** Multiplier applied to nodes outside the active overlay focus. */
const DIM_GAIN = 0.18;

/** Emissive brightness multiplier so stars push past the bloom luminance
 *  threshold and glow. */
const EMISSIVE_GAIN = 1.9;
/** Entrance animation duration (seconds): stars fade + scale in on first load
 *  while the camera eases to its fitted view. */
const ENTRANCE_SEC = 1.1;

/** The star-field: one THREE.Points buffer for every currently-visible
 *  cluster representative (collapsed clusters render as a single glow point;
 *  expanded clusters render their children). Click → select/expand;
 *  hover → highlight the 1-hop neighborhood and dim the rest. */
export function StarField() {
  const store = useStore();
  const model = store.model!;
  const pointsRef = useRef<THREE.Points>(null);
  const materialRef = useRef<THREE.PointsMaterial>(null);
  const hovered = store.hovered;

  const visible = useMemo(
    () => [...visibleClusters(model, store.expanded)],
    [model, store.expanded]
  );

  // Visible representatives that should stay BRIGHT while hovering: the hovered
  // node's representative + the representatives of its 1-hop neighbors.
  const highlightKeys = useMemo(() => {
    if (!hovered) return null;
    const visibleSet = new Set(visible);
    const repOf = (nodeId: string) => representativeFor(model, nodeId, visibleSet);
    const set = new Set<string>();
    const self = repOf(hovered);
    if (self) set.add(self);
    for (const e of model.drawEdges) {
      if (e.from === hovered) {
        const r = repOf(e.to);
        if (r) set.add(r);
      } else if (e.to === hovered) {
        const r = repOf(e.from);
        if (r) set.add(r);
      }
    }
    return set;
  }, [hovered, model, visible]);

  // Impact overlay: roll impacted / covering-test node ids up to the visible
  // cluster representatives so the highlight shows even when collapsed.
  const impactReps = useMemo(() => {
    if (!store.impact) return null;
    const visibleSet = new Set(visible);
    const repOf = (nodeId: string) => representativeFor(model, nodeId, visibleSet);
    const impacted = new Set<string>();
    const covering = new Set<string>();
    const sourceRep = repOf(store.impact.sourceId);
    for (const id of store.impact.impacted) {
      const r = repOf(id);
      if (r) impacted.add(r);
    }
    for (const id of store.impact.coveringTests) {
      const r = repOf(id);
      if (r) covering.add(r);
    }
    return { impacted, covering, sourceRep };
  }, [store.impact, model, visible]);

  // Tests lens: visible representatives that contain test code (so test stars
  // and the file/dir cores rolling them up stay bright).
  const testReps = useMemo(() => {
    if (store.emphasis !== "tests") return null;
    const visibleSet = new Set(visible);
    const set = new Set<string>();
    for (const rec of model.records.values()) {
      if (!isTestNode(rec)) continue;
      const r = representativeFor(model, rec.id, visibleSet);
      if (r) set.add(r);
    }
    return set;
  }, [store.emphasis, model, visible]);

  const { geometry, keysAt } = useMemo(() => {
    // Apply kind filter: exclude clusters whose symbolKind is in the hidden set.
    const filtered =
      store.filters.kinds.size > 0
        ? visible.filter((key) => {
            const c = model.byKey.get(key);
            return !(c?.symbolKind && store.filters.kinds.has(c.symbolKind.toLowerCase()));
          })
        : visible;

    const n = filtered.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const keysAt: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const key = filtered[i]!;
      const idx = model.indexByKey.get(key);
      keysAt[i] = key;
      if (idx === undefined) continue;
      positions[i * 3] = model.positions[idx * 3]!;
      positions[i * 3 + 1] = model.positions[idx * 3 + 1]!;
      positions[i * 3 + 2] = model.positions[idx * 3 + 2]!;
      const c = model.byKey.get(key)!;
      const deg = c.nodeId ? (model.records.get(c.nodeId)?.degree ?? 0) : 0;
      let [r, g, b] = nodeColor(c.kind, c.symbolKind);

      // --- Impact overlay (highest precedence): recolor impacted reps in the
      // accent, covering tests in the second accent, dim everything else.
      if (impactReps) {
        if (key === impactReps.sourceRep) {
          // The changed node stays its natural color, fully bright.
        } else if (impactReps.covering.has(key)) {
          [r, g, b] = COVERING_ACCENT;
        } else if (impactReps.impacted.has(key)) {
          [r, g, b] = IMPACT_ACCENT;
        } else {
          r *= DIM_GAIN;
          g *= DIM_GAIN;
          b *= DIM_GAIN;
        }
      } else if (store.emphasis === "types") {
        // Emphasize Class / Interface / Enum; dim other symbol stars (cluster
        // cores stay bright so structure remains legible).
        const sk = c.symbolKind?.toLowerCase();
        if (c.kind === "symbol" && !(sk && TYPE_EMPHASIS_KINDS.has(sk))) {
          r *= DIM_GAIN;
          g *= DIM_GAIN;
          b *= DIM_GAIN;
        }
      } else if (testReps) {
        // Tests lens: brighten test reps, dim everything else.
        if (!testReps.has(key)) {
          r *= DIM_GAIN;
          g *= DIM_GAIN;
          b *= DIM_GAIN;
        }
      }

      // Dim stars outside the hovered neighborhood; brighten everything (gain)
      // so the brightest cores bloom.
      let gain = EMISSIVE_GAIN;
      if (highlightKeys && !highlightKeys.has(key)) gain *= 0.22;
      r *= gain;
      g *= gain;
      b *= gain;
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
      sizes[i] = nodeSize(c.kind, deg);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    return { geometry: geo, keysAt };
  }, [visible, model, highlightKeys, store.filters, impactReps, testReps, store.emphasis]);

  // Entrance animation: ease opacity + point size from 0 on first appearance.
  const entranceStart = useRef<number | null>(null);
  useEffect(() => {
    entranceStart.current = performance.now();
  }, []);

  useFrame(() => {
    const mat = materialRef.current;
    if (!mat) return;
    const start = entranceStart.current;
    let t = 1;
    if (start !== null) {
      t = Math.min(1, (performance.now() - start) / 1000 / ENTRANCE_SEC);
      // ease-out cubic
      t = 1 - Math.pow(1 - t, 3);
    }
    mat.opacity = 0.95 * t;
    mat.size = 3 * (0.3 + 0.7 * t);
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = e.index;
    if (i === undefined) return;
    const key = keysAt[i];
    if (!key) return;
    const c = model.byKey.get(key);
    if (!c) return;
    if (c.kind === "symbol") {
      // Frame the star + open the detail panel.
      store.select(c.nodeId ?? key);
    } else {
      // Expand/collapse cluster, select its backing node if any. toggleExpand
      // bumps fitNonce so the camera refits to the new children.
      store.toggleExpand(key);
      if (c.nodeId) store.select(c.nodeId);
    }
  };

  const handleMove = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = e.index;
    const key = i === undefined ? null : keysAt[i] ?? null;
    const c = key ? model.byKey.get(key) : null;
    store.hover(c?.nodeId ?? key ?? null);
  };

  const handleOut = () => store.hover(null);

  const glow = useMemo(() => glowTexture(), []);

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      onClick={handleClick}
      onPointerMove={handleMove}
      onPointerOut={handleOut}
      raycast={pointsRaycast}
    >
      <pointsMaterial
        ref={materialRef}
        size={3}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.95}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        map={glow}
      />
    </points>
  );
}

/** A soft radial-gradient sprite so points look like round glowing stars. */
let _glow: THREE.Texture | null = null;
function glowTexture(): THREE.Texture {
  if (_glow) return _glow;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  _glow = tex;
  return tex;
}

// A picking threshold that keeps small stars clickable regardless of the
// global raycaster setting.
function pointsRaycast(
  this: THREE.Points,
  raycaster: THREE.Raycaster,
  intersects: THREE.Intersection[]
): void {
  const prev = raycaster.params.Points?.threshold;
  if (raycaster.params.Points) raycaster.params.Points.threshold = 2.5;
  THREE.Points.prototype.raycast.call(this, raycaster, intersects);
  if (raycaster.params.Points && prev !== undefined) raycaster.params.Points.threshold = prev;
}
