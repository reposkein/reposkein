/** Shared radial-gradient sprite-texture builder (design §7 chrome).
 *
 *  Several additive Points passes (star glow, flow pulses, nebula halos) all
 *  need the same thing: a soft round white radial-gradient on a canvas, used as
 *  the point `map` so bare square points read as glowing discs. Previously each
 *  scene component hand-rolled its own builder (StarField.glowTexture,
 *  FlowParticles.softSprite, NebulaHalos.haloTexture), which drifted. This is
 *  the single parameterized builder.
 *
 *  Deterministic: pure function of its arguments (no Math.random / Date.now),
 *  cached per distinct config so repeated calls return the SAME texture object
 *  (preserving the "build once, module-level" behavior each call site relied on).
 */

import * as THREE from "three";

/** One stop of the radial gradient: `offset` in [0,1], `alpha` in [0,1]
 *  (white at the given alpha). */
export interface GradientStop {
  offset: number;
  alpha: number;
}

export interface SpriteConfig {
  /** Square canvas edge in pixels. */
  size: number;
  /** White radial-gradient stops from center (offset 0) to edge (offset 1). */
  stops: GradientStop[];
}

/** Cache keyed on the exact config so identical sprites are built once and the
 *  SAME texture object is returned (mirrors the old module-level singletons). */
const CACHE = new Map<string, THREE.CanvasTexture>();

function cacheKey(cfg: SpriteConfig): string {
  return `${cfg.size}|${cfg.stops.map((s) => `${s.offset}:${s.alpha}`).join(",")}`;
}

/** Build (or return the cached) soft radial-gradient sprite texture. */
export function radialSprite(cfg: SpriteConfig): THREE.CanvasTexture {
  const key = cacheKey(cfg);
  const cached = CACHE.get(key);
  if (cached) return cached;

  const { size, stops } = cfg;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const s of stops) g.addColorStop(s.offset, `rgba(255,255,255,${s.alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  CACHE.set(key, tex);
  return tex;
}

/** Star glow: a tight bright core with a soft falloff (StarField points). */
export const STAR_GLOW: SpriteConfig = {
  size: 64,
  stops: [
    { offset: 0, alpha: 1 },
    { offset: 0.4, alpha: 0.6 },
    { offset: 1, alpha: 0 },
  ],
};

/** Flow pulse: like the star glow but a touch softer mid-stop (flow particles). */
export const FLOW_PULSE: SpriteConfig = {
  size: 64,
  stops: [
    { offset: 0, alpha: 1 },
    { offset: 0.4, alpha: 0.5 },
    { offset: 1, alpha: 0 },
  ],
};

/** Nebula halo: a very broad, low-alpha falloff so regions read as diffuse
 *  clouds rather than crisp discs (NebulaHalos points). */
export const NEBULA_HALO: SpriteConfig = {
  size: 128,
  stops: [
    { offset: 0, alpha: 0.55 },
    { offset: 0.25, alpha: 0.22 },
    { offset: 0.6, alpha: 0.05 },
    { offset: 1, alpha: 0 },
  ],
};
