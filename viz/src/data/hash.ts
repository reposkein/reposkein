/** Deterministic hashing + seeded PRNG for layout initialization.
 *
 *  DETERMINISM CONTRACT (design §4.3): layout MUST be byte-stable across
 *  reloads. We NEVER use Math.random() / Date.now() in the layout path.
 *  Every node's initial position is derived purely from a hash of its stable
 *  id string, and any further randomness goes through mulberry32 seeded from a
 *  fixed value. Same graph in → identical Float32Array out, every time. */

/** FNV-1a 32-bit hash of a string. Stable, fast, no deps. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply (kept in uint32 via Math.imul).
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny deterministic PRNG. Given the same seed it yields the same
 *  sequence in every JS engine. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Maps a stable id string to a deterministic point on a sphere of `radius`.
 *  Two independent hash streams (id and id+"#") give two angles, so the
 *  distribution is reasonable and fully reproducible. Returns [x, y, z]. */
export function idToPosition(id: string, radius = 60): [number, number, number] {
  const rng = mulberry32(fnv1a(id));
  // Uniform-ish sphere sampling from two seeded draws.
  const u = rng();
  const v = rng();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const r = radius * Math.cbrt(rng()); // fill the volume, not just the shell
  const x = r * Math.sin(phi) * Math.cos(theta);
  const y = r * Math.sin(phi) * Math.sin(theta);
  const z = r * Math.cos(phi);
  return [x, y, z];
}

/** A stable fingerprint of a list of strings (e.g. content hashes), used as
 *  the position-cache key. Deterministic; order-sensitive (callers pass
 *  already-sorted JSONL order). */
export function fingerprint(parts: string[]): string {
  let h = 0x811c9dc5;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      h ^= p.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
