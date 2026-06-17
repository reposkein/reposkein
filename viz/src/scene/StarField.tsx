import { useEffect, useMemo, useRef, useState } from "react";
import { type ThreeEvent, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../state/store";
import { representativeFor, visibleClusters } from "../data/clientModel";
import { nodeColor, nodeSize, BRAND_RGB, applyNodeFloor } from "./encoding";
import { isTestNode } from "../data/classify";
import { TYPE_EMPHASIS_KINDS } from "../data/lens";
import { diffExpanded, easeOutCubic, MORPH_MS } from "./supernova";
import type { RGB } from "./encoding";

/** Accent colors for the impact overlay (design: impacted vs covering tests).
 *  Harmonized to the brand palette: amber calls out impacted callers, teal the
 *  covering tests — the same two accents the rest of the UI uses for focus. */
const IMPACT_ACCENT: RGB = BRAND_RGB.amber; // impacted callers
const COVERING_ACCENT: RGB = BRAND_RGB.teal; // covering tests
/** Selection / hover accents (brand amber / teal). The selected star is tinted
 *  amber and the hovered star teal so the focused element reads instantly
 *  without collapsing the per-kind color encoding of everything else. */
const SELECT_ACCENT: RGB = BRAND_RGB.amber;
const HOVER_ACCENT: RGB = BRAND_RGB.teal;
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

  // Neighborhood focus: roll the bidirectional, depth-bounded neighborhood up
  // to visible reps so the focused region stays bright and the rest dims.
  const focusReps = useMemo(() => {
    if (!store.focus) return null;
    const visibleSet = new Set(visible);
    const set = new Set<string>();
    for (const id of store.focus.nodes) {
      const r = representativeFor(model, id, visibleSet);
      if (r) set.add(r);
    }
    return set;
  }, [store.focus, model, visible]);

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

  // Visible representatives of the selected / hovered node, so the focused star
  // can be tinted with the brand accent at any LOD (works on collapsed cores).
  const selectedRep = useMemo(() => {
    if (!store.selected) return null;
    return representativeFor(model, store.selected, new Set(visible));
  }, [store.selected, model, visible]);
  const hoveredRep = useMemo(() => {
    if (!hovered) return null;
    return representativeFor(model, hovered, new Set(visible));
  }, [hovered, model, visible]);

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
      } else if (focusReps) {
        // Neighborhood focus: members keep their natural color; everything
        // outside the focused region dims.
        if (!focusReps.has(key)) {
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

      // Selection / hover accent (brand amber / teal). Subordinate to the
      // impact overlay's own coloring (which owns the scene when active); hover
      // takes visual priority over a lingering selection on the same star.
      if (!impactReps) {
        if (hoveredRep && key === hoveredRep) {
          [r, g, b] = HOVER_ACCENT;
        } else if (selectedRep && key === selectedRep) {
          [r, g, b] = SELECT_ACCENT;
        }
      }

      // Dim stars outside the hovered neighborhood; brighten everything (gain)
      // so the brightest cores bloom.
      let gain = EMISSIVE_GAIN;
      if (highlightKeys && !highlightKeys.has(key)) gain *= 0.22;
      r *= gain;
      g *= gain;
      b *= gain;
      // Emissive floor so a dimmed star never reaches pure black (stays a faint
      // point of light under the web), preserving hue.
      const [fr, fg, fb] = applyNodeFloor(r, g, b);
      colors[i * 3] = fr;
      colors[i * 3 + 1] = fg;
      colors[i * 3 + 2] = fb;
      // Per-vertex size (importance) with a focus bump — the focused node reads
      // visibly larger. This feeds the REAL aSize attribute (see the material's
      // onBeforeCompile), so importance sizing + the bump are actually applied.
      const bump =
        key === selectedRep || key === hoveredRep
          ? 1.6
          : focusReps?.has(key)
          ? 1.25
          : 1;
      sizes[i] = nodeSize(c.kind, deg) * bump;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    return { geometry: geo, keysAt };
  }, [visible, model, highlightKeys, store.filters, impactReps, focusReps, testReps, store.emphasis, selectedRep, hoveredRep]);

  // --- Supernova expand/collapse morph -------------------------------------
  // Children emerge FROM their parent cluster's position outward to their
  // laid-out positions on expand, and recede INTO the parent on collapse.
  // GPU-friendly: we only animate the Points position buffer in useFrame
  // toward the (unchanged, deterministic) target positions. Interruptible: a
  // new toggle re-seeds origins from the current animated positions.
  //
  // morph holds the expand animation that runs IN the live buffer (origins per
  // visible key + a start time). lastPos tracks each rendered key's current
  // animated position so an interrupted morph blends smoothly.
  const morphRef = useRef<{ origin: Map<string, [number, number, number]>; start: number } | null>(
    null
  );
  const lastPosRef = useRef<Map<string, [number, number, number]>>(new Map());
  const prevExpandedRef = useRef<Set<string>>(new Set(store.expanded));
  // Departing points (collapse recession), rendered in a transient buffer that
  // lives only for the duration of the morph.
  const departRef = useRef<THREE.Points>(null);
  const departMorphRef = useRef<{
    positions: Float32Array; // mutated each frame (origin → target)
    origin: Float32Array;
    target: Float32Array; // parent core positions
    colors: Float32Array;
    start: number;
  } | null>(null);
  // Bumped whenever a new collapse morph is seeded, so the binding effect below
  // re-runs and rebinds the transient geometry's attributes (refs alone don't
  // trigger a render).
  const [departNonce, setDepartNonce] = useState(0);

  useEffect(() => {
    const prev = prevExpandedRef.current;
    const next = store.expanded;
    const { expanded: newlyExpanded, collapsed: newlyCollapsed } = diffExpanded(prev, next);
    prevExpandedRef.current = new Set(next);
    if (newlyExpanded.length === 0 && newlyCollapsed.length === 0) return;

    const now = performance.now();
    const expandedSet = new Set(newlyExpanded);

    // EXPAND: every currently-visible key whose nearest ancestor among the
    // just-expanded clusters exists bursts out from that cluster's position.
    if (newlyExpanded.length > 0) {
      const nowVisible = visibleClusters(model, next);
      const origin = new Map<string, [number, number, number]>();
      for (const key of nowVisible) {
        const chain = model.ancestors.get(key);
        if (!chain) continue;
        // Nearest expanded ancestor (deepest first), excluding the key itself.
        let burstFrom: string | null = null;
        for (let i = chain.length - 1; i >= 0; i--) {
          const ak = chain[i]!;
          if (ak === key) continue;
          if (expandedSet.has(ak)) {
            burstFrom = ak;
            break;
          }
        }
        if (!burstFrom) continue;
        // Start from the current animated position if mid-flight, else the
        // parent core position (the supernova origin).
        const cur = lastPosRef.current.get(key);
        if (cur) {
          origin.set(key, cur);
        } else {
          const pIdx = model.indexByKey.get(burstFrom);
          if (pIdx === undefined) continue;
          origin.set(key, [
            model.positions[pIdx * 3]!,
            model.positions[pIdx * 3 + 1]!,
            model.positions[pIdx * 3 + 2]!,
          ]);
        }
      }
      morphRef.current = origin.size > 0 ? { origin, start: now } : null;
    }

    // COLLAPSE: keys that left the visible set recede into the parent core they
    // collapsed into. Rendered in the transient departing buffer.
    if (newlyCollapsed.length > 0) {
      const prevVisible = visibleClusters(model, prev);
      const nowVisible = visibleClusters(model, next);
      const collapsedSet = new Set(newlyCollapsed);
      const departing: { key: string; into: string }[] = [];
      for (const key of prevVisible) {
        if (nowVisible.has(key)) continue; // still visible
        const chain = model.ancestors.get(key);
        if (!chain) continue;
        let into: string | null = null;
        for (let i = chain.length - 1; i >= 0; i--) {
          const ak = chain[i]!;
          if (ak === key) continue;
          if (collapsedSet.has(ak)) {
            into = ak;
            break;
          }
        }
        if (into) departing.push({ key, into });
      }
      if (departing.length > 0) {
        const n = departing.length;
        const origin = new Float32Array(n * 3);
        const target = new Float32Array(n * 3);
        const positions = new Float32Array(n * 3);
        const colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const { key, into } = departing[i]!;
          const idx = model.indexByKey.get(key);
          const pIdx = model.indexByKey.get(into);
          if (idx === undefined || pIdx === undefined) continue;
          const cur = lastPosRef.current.get(key) ?? [
            model.positions[idx * 3]!,
            model.positions[idx * 3 + 1]!,
            model.positions[idx * 3 + 2]!,
          ];
          origin[i * 3] = cur[0];
          origin[i * 3 + 1] = cur[1];
          origin[i * 3 + 2] = cur[2];
          positions[i * 3] = cur[0];
          positions[i * 3 + 1] = cur[1];
          positions[i * 3 + 2] = cur[2];
          target[i * 3] = model.positions[pIdx * 3]!;
          target[i * 3 + 1] = model.positions[pIdx * 3 + 1]!;
          target[i * 3 + 2] = model.positions[pIdx * 3 + 2]!;
          const c = model.byKey.get(key);
          const col = c ? nodeColor(c.kind, c.symbolKind) : ([0.8, 0.85, 0.95] as RGB);
          colors[i * 3] = col[0] * EMISSIVE_GAIN;
          colors[i * 3 + 1] = col[1] * EMISSIVE_GAIN;
          colors[i * 3 + 2] = col[2] * EMISSIVE_GAIN;
        }
        departMorphRef.current = { positions, origin, target, colors, start: now };
        setDepartNonce((n) => n + 1);
      }
    }
  }, [store.expanded, model]);

  // Entrance animation: ease opacity + point size from 0 on first appearance.
  const entranceStart = useRef<number | null>(null);
  useEffect(() => {
    entranceStart.current = performance.now();
  }, []);

  // Geometry for the transient departing (collapse) buffer.
  const departGeo = useMemo(() => new THREE.BufferGeometry(), []);

  useFrame(({ invalidate }) => {
    const mat = materialRef.current;
    if (mat) {
      const start = entranceStart.current;
      let t = 1;
      if (start !== null) {
        t = Math.min(1, (performance.now() - start) / 1000 / ENTRANCE_SEC);
        // ease-out cubic
        t = 1 - Math.pow(1 - t, 3);
      }
      mat.opacity = 0.95 * t;
      // Entrance/morph is a UNIFORM size multiplier that COMPOSES with the
      // per-vertex aSize (gl_PointSize = size * aSize) — it must NOT overwrite
      // the per-vertex sizing. Resting value 1.0 → gl_PointSize == aSize.
      mat.size = 0.3 + 0.7 * t;
    }

    const now = performance.now();

    // --- Expand morph: lerp the live Points buffer from origins toward targets.
    const pts = pointsRef.current;
    const posAttr = pts?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const lastPos = lastPosRef.current;
    if (pts && posAttr) {
      const arr = posAttr.array as Float32Array;
      const morph = morphRef.current;
      const e = morph ? easeOutCubic((now - morph.start) / MORPH_MS) : 1;
      let active = false;
      lastPos.clear();
      for (let i = 0; i < keysAt.length; i++) {
        const key = keysAt[i]!;
        const tIdx = model.indexByKey.get(key);
        if (tIdx === undefined) continue;
        const tx = model.positions[tIdx * 3]!;
        const ty = model.positions[tIdx * 3 + 1]!;
        const tz = model.positions[tIdx * 3 + 2]!;
        const o = morph && e < 1 ? morph.origin.get(key) : undefined;
        let x = tx;
        let y = ty;
        let z = tz;
        if (o) {
          x = o[0] + (tx - o[0]) * e;
          y = o[1] + (ty - o[1]) * e;
          z = o[2] + (tz - o[2]) * e;
          active = true;
        }
        arr[i * 3] = x;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = z;
        lastPos.set(key, [x, y, z]);
      }
      posAttr.needsUpdate = true;
      if (e >= 1) morphRef.current = null;
      if (active) invalidate();
    }

    // --- Collapse morph: lerp the transient departing buffer toward the parent
    // core, then drop it when finished.
    const dm = departMorphRef.current;
    const dpts = departRef.current;
    if (dm && dpts) {
      const e = easeOutCubic((now - dm.start) / MORPH_MS);
      const n = dm.positions.length / 3;
      for (let i = 0; i < n; i++) {
        dm.positions[i * 3] = dm.origin[i * 3]! + (dm.target[i * 3]! - dm.origin[i * 3]!) * e;
        dm.positions[i * 3 + 1] =
          dm.origin[i * 3 + 1]! + (dm.target[i * 3 + 1]! - dm.origin[i * 3 + 1]!) * e;
        dm.positions[i * 3 + 2] =
          dm.origin[i * 3 + 2]! + (dm.target[i * 3 + 2]! - dm.origin[i * 3 + 2]!) * e;
      }
      const dPos = dpts.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (dPos) dPos.needsUpdate = true;
      const dMat = dpts.material as THREE.PointsMaterial;
      dMat.opacity = 0.95 * (1 - e); // fade out as they recede
      if (e >= 1) {
        departMorphRef.current = null;
        dMat.opacity = 0;
      } else {
        invalidate();
      }
    }
  });

  // Bind the transient departing geometry whenever a new collapse morph starts
  // (departNonce bumps so this re-runs even though the morph lives in a ref).
  useEffect(() => {
    const dm = departMorphRef.current;
    if (!dm) return;
    const posAttr = new THREE.BufferAttribute(dm.positions, 3);
    departGeo.setAttribute("position", posAttr);
    departGeo.setAttribute("color", new THREE.BufferAttribute(dm.colors, 3));
    posAttr.needsUpdate = true;
  }, [departNonce, departGeo]);

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
    <>
      <points
        ref={pointsRef}
        geometry={geometry}
        onClick={handleClick}
        onPointerMove={handleMove}
        onPointerOut={handleOut}
        raycast={pointsRaycast}
        renderOrder={10}
      >
        <pointsMaterial
          ref={materialRef}
          size={1}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0.95}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          map={glow}
          onBeforeCompile={starSizeShader}
        />
      </points>
      {/* Transient departing stars (collapse recession). Non-interactive; the
          frame loop fades + lerps it into the parent core, then sets opacity 0. */}
      <points ref={departRef} geometry={departGeo} raycast={() => null}>
        <pointsMaterial
          size={3}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          map={glow}
        />
      </points>
    </>
  );
}

/** onBeforeCompile hook that makes the per-vertex `aSize` attribute REAL: the
 *  stock PointsMaterial vertex shader sets `gl_PointSize = size;` from the scalar
 *  uniform alone (so a per-vertex size attribute is silently ignored). We
 *  declare `aSize` and MULTIPLY it into gl_PointSize, so importance sizing and
 *  the focus size-bump actually render while the per-frame `size` uniform stays
 *  a global entrance/morph multiplier that composes (gl_PointSize = size·aSize).
 *  Mirrors the working pattern in NebulaHalos.tsx. */
function starSizeShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace("uniform float size;", "uniform float size;\nattribute float aSize;")
    .replace("gl_PointSize = size;", "gl_PointSize = size * aSize;");
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
