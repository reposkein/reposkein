/** Holten edge-bundling geometry (design §1.3). Each plan entry becomes a
 *  centripetal-Catmull-Rom polyline through its LCA control-point path, beta-
 *  straightened toward the chord, tessellated into K segments, and written into
 *  a SINGLE LineSegments-ready buffer. One draw call for the whole web.
 *
 *  Allocation-free build: the Catmull-Rom + beta math runs on RAW number
 *  triples in module-level scratch arrays written directly into the pre-sized
 *  Float32Array — no THREE.Vector3 / CatmullRomCurve3 / .clone() per bundle, so
 *  the per-hover useMemo rebuild doesn't GC-thrash. Pure & deterministic. */

import * as THREE from "three";
import type { ClientModel } from "../data/clientModel";

const BUDGET_SEGMENTS = 150_000;
const K_FULL = 12;
const K_MID = 8;
const MANY_BUNDLES = 4000;

/** Control-point keys along the LCA path of the cluster tree: src..LCA..dst.
 *  Pure. Cross-repo bundles whose ancestor chains share no root return the
 *  straight 2-key chord (no spurious chain[-1] indexing). */
export function bundlePath(model: ClientModel, srcKey: string, dstKey: string): string[] {
  const s = model.ancestors.get(srcKey);
  const d = model.ancestors.get(dstKey);
  if (!s || !d) return [srcKey, dstKey];
  let lca = 0;
  const m = Math.min(s.length, d.length);
  while (lca < m && s[lca] === d[lca]) lca++;
  const lcaIdx = lca - 1; // last shared index
  if (lcaIdx < 0) return [srcKey, dstKey]; // disjoint roots (cross-repo) → straight
  const path: string[] = [];
  for (let i = s.length - 1; i >= lcaIdx; i--) path.push(s[i]!); // src → LCA
  for (let i = lcaIdx + 1; i < d.length; i++) path.push(d[i]!); // LCA → dst
  return path;
}

/** Per-bundle K under a global budget. Pure over the (already-sorted) plan. */
export function segmentCounts(
  model: ClientModel,
  plan: { srcKey: string; dstKey: string }[],
): number[] {
  const dense = plan.length > MANY_BUNDLES;
  const kFull = dense ? K_MID : K_FULL;
  const kMid = dense ? 4 : K_MID;
  const base = plan.map((p) => {
    const len = bundlePath(model, p.srcKey, p.dstKey).length;
    return len <= 2 ? 1 : len === 3 ? kMid : kFull; // straight when degenerate
  });
  const total = base.reduce((a, c) => a + c, 0);
  if (total <= BUDGET_SEGMENTS) return base;
  const scale = BUDGET_SEGMENTS / total; // degrade gracefully → straighter
  // floor (not round) so the rescaled total can never EXCEED the budget; the
  // `max(1)` floor keeps every bundle drawable (a tiny, bounded overshoot only
  // when nearly every bundle would otherwise round to 0 — far under the cap in
  // practice given MANY_BUNDLES drops K first).
  return base.map((kk) => Math.max(1, Math.floor(kk * scale)));
}

// Module-level scratch for control points (raw triples) so the build never
// allocates per bundle. Sized lazily to the deepest path seen.
let CX = new Float64Array(64);
let CY = new Float64Array(64);
let CZ = new Float64Array(64);
function ensureScratch(n: number): void {
  if (n <= CX.length) return;
  const cap = Math.max(n, CX.length * 2);
  CX = new Float64Array(cap);
  CY = new Float64Array(cap);
  CZ = new Float64Array(cap);
}

/** Centripetal Catmull-Rom knot spacing: t_{i+1} = t_i + |P_{i+1}-P_i|^0.5.
 *  Returned into KNOTS (module scratch). */
let KNOTS = new Float64Array(64);
function ensureKnots(n: number): void {
  if (n > KNOTS.length) KNOTS = new Float64Array(Math.max(n, KNOTS.length * 2));
}

/** Build one LineSegments-ready geometry for the whole plan. `beta` straightens
 *  interior control points toward the chord (1 = full curve, 0 = straight line
 *  reproducing today's render). `k` is the adaptive global opacity scale; colors
 *  arrive un-premultiplied as (r,g,b,a) and are premultiplied here. */
export function buildBundledGeometry(
  model: ClientModel,
  plan: { srcKey: string; dstKey: string; r: number; g: number; b: number; a: number }[],
  beta: number,
  k: number,
): THREE.BufferGeometry {
  const Ks = segmentCounts(model, plan);
  let totalSegs = 0;
  for (const kk of Ks) totalSegs += kk;
  const positions = new Float32Array(totalSegs * 2 * 3);
  const colors = new Float32Array(totalSegs * 2 * 3);
  let w = 0; // float write cursor

  const P = model.positions;
  const ix = model.indexByKey;

  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]!;
    const K = Ks[i]!;
    const a = p.a * k;
    const cr = p.r * a;
    const cg = p.g * a;
    const cb = p.b * a; // premultiplied

    const keys = bundlePath(model, p.srcKey, p.dstKey);

    // Gather control points (raw triples) into scratch, skipping missing keys.
    ensureScratch(keys.length);
    let nc = 0;
    for (const key of keys) {
      const idx = ix.get(key);
      if (idx === undefined) continue;
      CX[nc] = P[idx * 3]!;
      CY[nc] = P[idx * 3 + 1]!;
      CZ[nc] = P[idx * 3 + 2]!;
      nc++;
    }
    if (nc < 2) continue;

    // Straight fast-path: degenerate path or single-segment budget.
    if (K === 1 || nc === 2) {
      w = pushSeg(positions, colors, w, CX[0]!, CY[0]!, CZ[0]!, CX[nc - 1]!, CY[nc - 1]!, CZ[nc - 1]!, cr, cg, cb);
      continue;
    }

    // Beta straightening: pull each interior control point toward its position
    // on the chord. P' = beta·P + (1-beta)·chord. beta=0 → all on the chord.
    const last = nc - 1;
    const x0 = CX[0]!, y0 = CY[0]!, z0 = CZ[0]!;
    const xn = CX[last]!, yn = CY[last]!, zn = CZ[last]!;
    for (let j = 1; j < last; j++) {
      const t = j / last;
      const chx = x0 + (xn - x0) * t;
      const chy = y0 + (yn - y0) * t;
      const chz = z0 + (zn - z0) * t;
      CX[j] = beta * CX[j]! + (1 - beta) * chx;
      CY[j] = beta * CY[j]! + (1 - beta) * chy;
      CZ[j] = beta * CZ[j]! + (1 - beta) * chz;
    }

    // Centripetal knot parameterization over the (straightened) control points.
    ensureKnots(nc);
    KNOTS[0] = 0;
    for (let j = 1; j < nc; j++) {
      const dx = CX[j]! - CX[j - 1]!;
      const dy = CY[j]! - CY[j - 1]!;
      const dz = CZ[j]! - CZ[j - 1]!;
      const dist = Math.sqrt(Math.sqrt(dx * dx + dy * dy + dz * dz)); // ^0.5 (centripetal, alpha=0.5)
      // Guard coincident points (zero knot delta breaks the spline divisions).
      KNOTS[j] = KNOTS[j - 1]! + (dist > 1e-6 ? dist : 1e-6);
    }

    // Tessellate: evaluate the centripetal Catmull-Rom spline at K+1 samples
    // uniformly in arc-knot space, emitting K segments (duplicated interior
    // verts so LineSegments draws a continuous polyline). px/py/pz hold prev.
    const tStart = KNOTS[0]!;
    const tEnd = KNOTS[last]!;
    let px = CX[0]!, py = CY[0]!, pz = CZ[0]!;
    for (let sIdx = 1; sIdx <= K; sIdx++) {
      const tt = tStart + ((tEnd - tStart) * sIdx) / K;
      // Locate the segment [seg, seg+1] containing tt.
      let seg = 0;
      while (seg < last - 1 && KNOTS[seg + 1]! < tt) seg++;
      const cx = evalCR(CX, KNOTS, seg, last, tt);
      const cy = evalCR(CY, KNOTS, seg, last, tt);
      const cz = evalCR(CZ, KNOTS, seg, last, tt);
      w = pushSeg(positions, colors, w, px, py, pz, cx, cy, cz, cr, cg, cb);
      px = cx;
      py = cy;
      pz = cz;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setDrawRange(0, w / 3); // guards the rare skipped (idx undefined) bundle
  return geo;
}

/** Non-uniform (centripetal) Catmull-Rom evaluation of one coordinate channel
 *  `C` at parameter `tt`, on segment [seg, seg+1] with knots in `K` (length
 *  last+1). Uses the Barry-Goldman recursive pyramid so it handles the non-
 *  uniform knot spacing correctly. Endpoints clamp the missing neighbor. Pure;
 *  operates on raw Float64Array, no allocation. */
function evalCR(
  C: Float64Array,
  K: Float64Array,
  seg: number,
  last: number,
  tt: number,
): number {
  const i1 = seg;
  const i2 = seg + 1;
  const i0 = i1 > 0 ? i1 - 1 : i1;
  const i3 = i2 < last ? i2 + 1 : i2;

  const t0 = K[i0]!;
  const t1 = K[i1]!;
  const t2 = K[i2]!;
  const t3 = K[i3]!;
  const p0 = C[i0]!;
  const p1 = C[i1]!;
  const p2 = C[i2]!;
  const p3 = C[i3]!;

  // Barry-Goldman pyramid with guards for coincident knots (endpoint clamps).
  const d01 = t1 - t0;
  const d12 = t2 - t1;
  const d23 = t3 - t2;
  const A1 = d01 > 1e-9 ? ((t1 - tt) * p0 + (tt - t0) * p1) / d01 : p1;
  const A2 = d12 > 1e-9 ? ((t2 - tt) * p1 + (tt - t1) * p2) / d12 : p1;
  const A3 = d23 > 1e-9 ? ((t3 - tt) * p2 + (tt - t2) * p3) / d23 : p2;
  const d02 = t2 - t0;
  const d13 = t3 - t1;
  const B1 = d02 > 1e-9 ? ((t2 - tt) * A1 + (tt - t0) * A2) / d02 : A2;
  const B2 = d13 > 1e-9 ? ((t3 - tt) * A2 + (tt - t1) * A3) / d13 : A2;
  return d12 > 1e-9 ? ((t2 - tt) * B1 + (tt - t1) * B2) / d12 : B1;
}

function pushSeg(
  pos: Float32Array,
  col: Float32Array,
  w: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cr: number,
  cg: number,
  cb: number,
): number {
  pos[w] = ax;
  pos[w + 1] = ay;
  pos[w + 2] = az;
  pos[w + 3] = bx;
  pos[w + 4] = by;
  pos[w + 5] = bz;
  col[w] = cr;
  col[w + 1] = cg;
  col[w + 2] = cb;
  col[w + 3] = cr;
  col[w + 4] = cg;
  col[w + 5] = cb;
  return w + 6;
}
