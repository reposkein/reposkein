import { useMemo, useRef } from "react";
import { type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../state/store";
import { visibleClusters } from "../data/clientModel";
import { nodeColor, nodeSize } from "./encoding";

/** The star-field: one THREE.Points buffer for every currently-visible
 *  cluster representative (collapsed clusters render as a single glow point;
 *  expanded clusters render their children). Click → select/expand. */
export function StarField() {
  const store = useStore();
  const model = store.model!;
  const pointsRef = useRef<THREE.Points>(null);

  const visible = useMemo(
    () => [...visibleClusters(model, store.expanded)],
    [model, store.expanded]
  );

  const { geometry, keysAt } = useMemo(() => {
    const n = visible.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const keysAt: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const key = visible[i]!;
      const idx = model.indexByKey.get(key);
      keysAt[i] = key;
      if (idx === undefined) continue;
      positions[i * 3] = model.positions[idx * 3]!;
      positions[i * 3 + 1] = model.positions[idx * 3 + 1]!;
      positions[i * 3 + 2] = model.positions[idx * 3 + 2]!;
      const c = model.byKey.get(key)!;
      const deg = c.nodeId ? (model.records.get(c.nodeId)?.degree ?? 0) : 0;
      const [r, g, b] = nodeColor(c.kind, c.symbolKind);
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
  }, [visible, model]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const i = e.index;
    if (i === undefined) return;
    const key = keysAt[i];
    if (!key) return;
    const c = model.byKey.get(key);
    if (!c) return;
    if (c.kind === "symbol") {
      store.select(c.nodeId ?? key);
    } else {
      // Expand/collapse cluster, and select its backing node if any.
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

  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 3,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        map: glowTexture(),
      }),
    []
  );

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      material={material}
      onClick={handleClick}
      onPointerMove={handleMove}
      onPointerOut={handleOut}
      raycast={pointsRaycast}
    />
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
