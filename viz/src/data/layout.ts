/** Deterministic 3D force layout (design §4).
 *
 *  Runs d3-force-3d to a FIXED iteration count with:
 *   - every node's initial x/y/z pre-set from idToPosition(stableKey)
 *     (a hash → seeded position; NO Math.random),
 *   - a seeded random source on the simulation (kills d3's internal jitter),
 *   - structural CONTAINS/DEFINES springs derived from the cluster tree.
 *
 *  Result: byte-stable Float32Array positions for the same graph, every run.
 *  Positions are render-time only and never written back to JSONL.
 *
 *  This module is pure (no DOM / no worker globals) so it is directly unit
 *  testable and is also imported by the layout web worker. */

import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  type SimulationNodeDatum,
} from "d3-force-3d";
import type { ClusterTree } from "./cluster";
import { flattenTree } from "./cluster";
import { idToPosition, mulberry32, fnv1a, fingerprint } from "./hash";

const LAYOUT_SEED = 0x5eed_1234;

/** Bumped whenever the layout algorithm, force parameters, OR the adaptive
 *  iteration schedule (layoutIterations) changes — anything that alters the
 *  byte output for a given graph. The position cache keys on this so a stale
 *  cached layout from a previous algorithm is never reused after an upgrade.
 *
 *  HISTORY:
 *   v1 — initial cached layout (adaptive iterations 200/150/100/70). */
export const LAYOUT_VERSION = 1;

/** Stable position-cache fingerprint for a graph's node set.
 *
 *  Positions are a pure function of the cluster tree (derived from node ids +
 *  structure) and the layout algorithm, so the cache key is the SORTED node-id
 *  list + the node count + LAYOUT_VERSION. Sorting makes it independent of JSONL
 *  ordering; the count guards against (astronomically unlikely) id-set hash
 *  collisions at a different size; the version invalidates on algorithm change.
 *
 *  Deterministic: same node set + version → identical key, every run. */
export function layoutFingerprint(nodeIds: string[]): string {
  const sorted = [...nodeIds].sort();
  return fingerprint([`v${LAYOUT_VERSION}`, `n${sorted.length}`, ...sorted]);
}

/** Force-layout iteration count, adaptive to node count but DETERMINISTIC: a
 *  fixed number of ticks for a given size, so the same graph always lays out
 *  identically. Small graphs converge with the full 200 ticks; huge graphs
 *  (the ~12k design target) step down to a cheaper-but-stable count rather than
 *  paying 200 quadtree ticks. The thresholds are constants → byte-stable. */
export function layoutIterations(nodeCount: number): number {
  if (nodeCount <= 2000) return 200;
  if (nodeCount <= 5000) return 150;
  if (nodeCount <= 10000) return 100;
  return 70;
}

interface SimNode extends SimulationNodeDatum {
  key: string;
  x: number;
  y: number;
  z: number;
}

export interface LayoutResult {
  /** Cluster keys in the canonical (flattened) order. */
  keys: string[];
  /** Flat [x0,y0,z0, x1,y1,z1, ...] aligned with `keys`. */
  positions: Float32Array;
  /** key -> index into `keys` / position triples. */
  indexByKey: Map<string, number>;
}

/** Computes the deterministic layout for an entire cluster tree.
 *
 *  Single-pass force layout over all clusters with parent→child structural
 *  links (the spec's hierarchical-freeze refinement is deferred; M1 needs a
 *  stable, navigable map and this is fully deterministic). */
export function computeLayout(tree: ClusterTree, cachedPositions?: Float32Array): LayoutResult {
  const flat = flattenTree(tree);
  const keys = flat.map((c) => c.key);
  const indexByKey = new Map<string, number>();
  keys.forEach((k, i) => indexByKey.set(k, i));

  // Position-cache hit: the cached buffer aligns with the canonical key order
  // (same node set → same deterministic tree → same flatten order), so we reuse
  // it and skip the (slow) force simulation entirely. Length-guard against a
  // mismatched/corrupt buffer; on mismatch we fall through to recompute.
  if (cachedPositions && cachedPositions.length === keys.length * 3) {
    // Copy so the model owns its buffer (the cache may keep/transfer its own).
    return { keys, positions: cachedPositions.slice(), indexByKey };
  }

  const nodes: SimNode[] = flat.map((c) => {
    const [x, y, z] = idToPosition(c.key);
    return { key: c.key, x, y, z };
  });

  // Structural links: parent → child (CONTAINS/DEFINES skeleton). These are
  // NOT drawn; they only shape the layout.
  const links = flat
    .filter((c) => c.parent !== null)
    .map((c) => ({ source: c.parent as string, target: c.key }));

  // Seeded RNG: d3-force-3d uses the simulation's randomSource for any jitter.
  const rng = mulberry32(fnv1a("randomSource") ^ LAYOUT_SEED);

  // Tightened spread (design §4): a gentler charge, shorter structural springs
  // and a stronger centering pull keep the top-level clusters close enough to
  // read as ONE constellation rather than a scattered cloud. All values are
  // constants — the layout stays byte-deterministic (layout.test).
  const sim = forceSimulation(nodes, 3)
    .force("charge", forceManyBody().strength(-7))
    .force(
      "link",
      forceLink(links)
        .id((d: SimNode) => d.key)
        .distance(5)
        .strength(0.85)
    )
    .force("center", forceCenter(0, 0, 0))
    .stop();

  // Kill internal nondeterminism where the API allows it.
  const simAny = sim as unknown as { randomSource?: (fn: () => number) => unknown };
  if (typeof simAny.randomSource === "function") simAny.randomSource(rng);

  // Run a fixed (size-adaptive) number of ticks — no animation/timer-driven
  // randomness. The count is a pure function of node count, so it stays
  // byte-deterministic for any given graph.
  sim.tick(layoutIterations(nodes.length));

  const positions = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    positions[i * 3] = n.x ?? 0;
    positions[i * 3 + 1] = n.y ?? 0;
    positions[i * 3 + 2] = n.z ?? 0;
  }

  return { keys, positions, indexByKey };
}
