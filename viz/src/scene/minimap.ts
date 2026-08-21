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

/** Collects the X/Y of the CURRENTLY-VISIBLE clusters only, as a flat
 *  [x0,y0, x1,y1, …] buffer.
 *
 *  This is the V3 fix for the footprint mismatch the retired MinimapPanel had:
 *  it projected `model.positions` WHOLESALE — every node in the graph, expanded
 *  or not — so the dots on the map never corresponded to the stars on screen,
 *  and the map's bounds (and therefore its scale) were those of a graph the
 *  viewer wasn't looking at. Collapsing a directory visibly changed the scene
 *  and left the minimap untouched.
 *
 *  `indexByKey` misses are skipped rather than treated as the origin — a
 *  cluster key with no layout slot must not drag the bounds to (0,0). Pure. */
export function visibleXY(
  positions: Float32Array,
  indexByKey: Map<string, number>,
  visible: Iterable<string>,
): Float32Array {
  const xs: number[] = [];
  for (const key of visible) {
    const idx = indexByKey.get(key);
    if (idx === undefined) continue;
    const x = positions[idx * 3];
    const y = positions[idx * 3 + 1];
    if (x === undefined || y === undefined) continue;
    xs.push(x, y);
  }
  return new Float32Array(xs);
}

/** Bounds of a flat [x0,y0, x1,y1, …] XY buffer (the output of `visibleXY`).
 *  The 3-stride `projectBounds` above stays for callers holding a raw world
 *  position buffer. Zero-extent box at the origin when empty. Pure. */
export function boundsOfXY(xy: Float32Array): MinimapBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const n = Math.floor(xy.length / 2);
  for (let i = 0; i < n; i++) {
    const x = xy[i * 2]!;
    const y = xy[i * 2 + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

/** World-space half-extents of what a perspective camera sees on the plane
 *  through its orbit target — i.e. the viewport frustum rectangle the minimap
 *  draws so you can tell WHERE you are, not just what the target point is.
 *
 *  Half-height is `tan(fov/2) · distance` (the standard perspective relation);
 *  half-width scales it by the viewport aspect. Guards non-finite / non-positive
 *  inputs to a zero rect rather than NaN, so a pre-mount frame draws nothing
 *  instead of corrupting the canvas path. Pure. */
export function viewportHalfExtents(
  distance: number,
  fovDegrees: number,
  aspect: number,
): { halfW: number; halfH: number } {
  if (
    !Number.isFinite(distance) ||
    !Number.isFinite(fovDegrees) ||
    !Number.isFinite(aspect) ||
    distance <= 0 ||
    fovDegrees <= 0 ||
    aspect <= 0
  ) {
    return { halfW: 0, halfH: 0 };
  }
  const halfH = Math.tan((fovDegrees * Math.PI) / 360) * distance;
  return { halfW: halfH * aspect, halfH };
}

