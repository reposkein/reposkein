/** Pure 2D projection math for the minimap / overview inset (design: share &
 *  scale §P2). No DOM / r3f imports so it's unit-testable under the node vitest
 *  environment. The minimap is a cheap top-down (X/Y) orthographic projection
 *  of the whole graph's node positions onto a fixed-size canvas, plus an
 *  inverse mapping so a click recenters the camera near that world location. */

export interface MinimapBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface MinimapProjection {
  bounds: MinimapBounds;
  /** Uniform world→pixel scale (same on both axes, preserves aspect). */
  scale: number;
  /** Pixel offset of the world origin after centering inside the canvas. */
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** Compute the axis-aligned bounds of a flat [x0,y0,z0, x1,y1,z1, ...] buffer
 *  using the X/Y plane only (top-down projection). Returns a zero-extent box at
 *  the origin when there are no points. Pure. */
export function projectBounds(positions: Float32Array): MinimapBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const n = Math.floor(positions.length / 3);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

/** Build a uniform-aspect projection that fits `bounds` inside a
 *  `width`×`height` canvas with `pad` pixels of margin. Pure & deterministic. */
export function buildProjection(
  bounds: MinimapBounds,
  width: number,
  height: number,
  pad = 6,
): MinimapProjection {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const availW = Math.max(width - pad * 2, 1);
  const availH = Math.max(height - pad * 2, 1);
  // Uniform scale to preserve aspect (fit the larger relative span).
  const scale = Math.min(availW / spanX, availH / spanY);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  // Center the projected box inside the canvas.
  const offsetX = width / 2 - cx * scale;
  const offsetY = height / 2 - cy * scale;
  return { bounds, scale, offsetX, offsetY, width, height };
}

/** World (x,y) → minimap pixel (px,py). Y is flipped so +Y world is "up" on
 *  screen (canvas pixel-Y grows downward). Pure. */
export function worldToMinimap(
  proj: MinimapProjection,
  x: number,
  y: number,
): { px: number; py: number } {
  const px = x * proj.scale + proj.offsetX;
  const py = proj.height - (y * proj.scale + proj.offsetY);
  return { px, py };
}

/** Minimap pixel (px,py) → world (x,y) on the projected plane (z=0). Inverse of
 *  worldToMinimap. Used to recenter the camera on a minimap click. Pure. */
export function minimapToWorld(
  proj: MinimapProjection,
  px: number,
  py: number,
): { x: number; y: number } {
  const x = (px - proj.offsetX) / proj.scale;
  const y = (proj.height - py - proj.offsetY) / proj.scale;
  return { x, y };
}
