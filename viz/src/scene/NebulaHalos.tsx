import { useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../state/store";
import { visibleClusters } from "../data/clientModel";
import { BRAND_RGB, nodeColor } from "./encoding";
import type { ClientModel } from "../data/clientModel";

/** Faint additive glow behind each visible cluster so a region reads as a
 *  region — a "nebula" the cluster's stars sit inside. Implemented as ONE
 *  THREE.Points pass (one large soft sprite per visible galaxy/dir/file core),
 *  so it stays a single draw call regardless of how many clusters are visible.
 *
 *  Color: harmonized to the cluster's kind hue (brand-amber for galaxy roots),
 *  desaturated toward the navy so it tints rather than washes. Size: scaled by
 *  the cluster's spatial extent (how far its descendants spread) so a big crate
 *  gets a big halo and a tiny file a tiny one. Symbols (leaf stars) get no halo.
 *
 *  Subtle by design: low opacity + additive blending means it deepens regions
 *  without fogging the stars in front of it (depthWrite off, drawn first). */
export function NebulaHalos() {
  const store = useStore();
  const model = store.model!;

  // Per-cluster spatial extent: max distance from the cluster core to any of
  // its (recursive) descendant positions. Pure function of the model layout,
  // so it's computed once per model and cached — independent of expansion.
  const extentByKey = useMemo(() => computeExtents(model), [model]);

  const geometry = useMemo(() => {
    const visible = visibleClusters(model, store.expanded);

    const positions: number[] = [];
    const colors: number[] = [];
    const sizes: number[] = [];

    for (const key of visible) {
      const c = model.byKey.get(key);
      if (!c || c.kind === "symbol") continue; // only cluster regions get halos
      const idx = model.indexByKey.get(key);
      if (idx === undefined) continue;

      // Halo radius from the cluster's spread, with a kind-dependent floor so a
      // collapsed core (whose descendants are hidden but still laid out) still
      // shows a small bloom of region color.
      const extent = extentByKey.get(key) ?? 0;
      const floor = c.kind === "galaxy" ? 26 : c.kind === "dir" ? 16 : 9;
      const size = Math.max(floor, extent * 2.2);

      // Region tint: the cluster kind hue (galaxy uses brand amber) pulled
      // toward navy so the halo is a deep glow, not a bright disc.
      const base = c.kind === "galaxy" ? BRAND_RGB.amber : nodeColor(c.kind, c.symbolKind);
      const TINT = 0.34; // how much of the hue survives vs. sinking into navy
      const r = base[0] * TINT;
      const g = base[1] * TINT;
      const b = base[2] * TINT;

      positions.push(
        model.positions[idx * 3]!,
        model.positions[idx * 3 + 1]!,
        model.positions[idx * 3 + 2]!
      );
      colors.push(r, g, b);
      sizes.push(size);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
    return geo;
  }, [model, store.expanded, extentByKey]);

  const map = useMemo(() => haloTexture(), []);

  // A custom point material that respects the per-point `size` attribute as a
  // WORLD-space radius (so a halo's footprint tracks the cluster's spatial
  // extent and shrinks/grows correctly with camera distance). Built on the
  // standard PointsMaterial shader via onBeforeCompile to keep it cheap and to
  // inherit fog support.
  const material = useMemo(() => sizedPointsMaterial(map), [map]);

  return (
    <points geometry={geometry} material={material} renderOrder={-1} raycast={() => null} />
  );
}

/** Computes, per cluster key, the max distance from the cluster core position
 *  to any descendant position (recursive). Bottom-up over the flattened tree
 *  using ancestor chains; O(nodes · depth). Pure / deterministic. */
function computeExtents(model: ClientModel): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key] of model.indexByKey) {
    const c = model.byKey.get(key);
    if (!c || c.kind === "symbol") continue; // leaves have no extent
    out.set(key, 0);
  }
  // For each node, walk its ancestor chain and update each ancestor's extent
  // with the distance from that ancestor's core to this node.
  for (const [key, idx] of model.indexByKey) {
    const chain = model.ancestors.get(key);
    if (!chain) continue;
    const nx = model.positions[idx * 3]!;
    const ny = model.positions[idx * 3 + 1]!;
    const nz = model.positions[idx * 3 + 2]!;
    for (const ak of chain) {
      if (ak === key) continue;
      const aIdx = model.indexByKey.get(ak);
      if (aIdx === undefined) continue;
      const dx = nx - model.positions[aIdx * 3]!;
      const dy = ny - model.positions[aIdx * 3 + 1]!;
      const dz = nz - model.positions[aIdx * 3 + 2]!;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const prev = out.get(ak);
      if (prev !== undefined && d > prev) out.set(ak, d);
    }
  }
  return out;
}

/** A very soft radial-gradient sprite — broad falloff so halos read as diffuse
 *  nebulae rather than crisp discs. */
let _halo: THREE.Texture | null = null;
function haloTexture(): THREE.Texture {
  if (_halo) return _halo;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.55)");
  g.addColorStop(0.25, "rgba(255,255,255,0.22)");
  g.addColorStop(0.6, "rgba(255,255,255,0.05)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  _halo = tex;
  return tex;
}

/** PointsMaterial whose per-point `size` attribute is treated as a world-space
 *  diameter with size-attenuation, so halo footprints scale with the cluster's
 *  spatial extent (the default PointsMaterial uses a single scalar size). */
function sizedPointsMaterial(map: THREE.Texture): THREE.PointsMaterial {
  const mat = new THREE.PointsMaterial({
    size: 1,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    map,
    fog: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("uniform float size;", "uniform float size;\nattribute float aSize;")
      .replace("gl_PointSize = size;", "gl_PointSize = aSize;");
  };
  return mat;
}
