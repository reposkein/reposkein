import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../state/store";
import {
  selectVisibleEdges,
  repOf,
  hoveredRepOf,
  focusRepsOf,
} from "../data/clientModel";
import { edgeColor, bundleOpacity, adaptiveEdgeScale } from "./encoding";
import { buildBundledGeometry } from "./bundleGeometry";

/** Extracts the galaxy prefix from a cluster key (for cross-repo detection).
 *  Cluster keys look like "galaxy:repoId", "dir:repoId:path", etc.
 *  We extract the repoId portion: second segment for non-galaxy keys. */
function galaxyOf(key: string): string {
  if (key.startsWith("galaxy:")) return key; // "galaxy:repoId" → itself
  const parts = key.split(":");
  // "dir:repoId:path" → "repoId", "rs1:repoId:..." → "repoId"
  return parts[1] ?? key;
}

/** True if any element of `a` is in `b` (cheap set intersection test). */
function setHasAny(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/** Relationship connections as a SINGLE additive LineSegments buffer
 *  (design §1). ONE deterministic select→style→route pass: selectVisibleEdges
 *  rolls raw edges up to the deepest currently-visible reps with the symbol→file
 *  LOD clamp (so the default view is clean file-level arcs, not a hairball), a
 *  fixed-order style pass composes LOD length falloff, impact, focus/incidence,
 *  cross-repo brighten and adaptive global opacity, and buildBundledGeometry
 *  routes each bundle along its hierarchy LCA path as a Holten-bundled curve.
 *  bundleBeta=0 reproduces today's straight lines. One draw call. */
export function EdgeLines() {
  const store = useStore();
  const model = store.model!;
  const hovered = store.hovered;

  const { geometry, drawn, total } = useMemo(() => {
    // STAGE A — selection + LOD roll-up. activeNodes (selected ∪ hovered ∪
    // focus.nodes) make their files render at symbol granularity.
    const activeNodes = [store.selected, hovered, ...(store.focus?.nodes ?? [])].filter(
      Boolean,
    ) as string[];
    const { bundles, visible, total } = selectVisibleEdges(model, {
      expanded: store.expanded,
      filters: {
        edgeTypes: store.filters.edgeTypes,
        minConfidence: store.filters.minConfidence,
        audit: store.audit,
      },
      activeNodes,
    });

    // Active rep set (incidence) + focusReps (wholly-inside) — via the shared
    // rep helpers (no duplicated chain walks).
    const selRep = store.selected ? repOf(model, store.selected, visible) : null;
    const hovRep = hovered ? hoveredRepOf(model, hovered, visible) : null;
    const focusReps = focusRepsOf(model, store.focus, visible);
    const active = new Set<string>();
    if (selRep) active.add(selRep);
    if (hovRep) active.add(hovRep);
    if (focusReps) for (const k of focusReps) active.add(k);
    const focusActive = active.size > 0;
    const impactSet = store.impact
      ? new Set<string>([store.impact.sourceId, ...store.impact.impacted])
      : null;

    type Plan = { srcKey: string; dstKey: string; r: number; g: number; b: number; a: number };
    const plan: Plan[] = [];
    for (const bnd of bundles) {
      if (!model.indexByKey.has(bnd.srcKey) || !model.indexByKey.has(bnd.dstKey)) continue;
      let [r, g, b] = edgeColor(bnd.dominantType);
      let a = bundleOpacity(bnd.bestResolution, bnd.count) * bnd.lengthAtten; // (1) LOD falloff

      if (impactSet) {
        // (2) impact overlay
        const onPath =
          bnd.dominantType === "CALLS" &&
          setHasAny(bnd.srcNodes, impactSet) &&
          setHasAny(bnd.dstNodes, impactSet);
        if (onPath) {
          r = 1;
          g = 0.42;
          b = 0.32;
          a = Math.min(1, a * 1.8);
        } else {
          a *= 0.08;
        }
      }
      if (focusActive) {
        // (3) focus + context
        const inside = focusReps ? focusReps.has(bnd.srcKey) && focusReps.has(bnd.dstKey) : false;
        const incident = active.has(bnd.srcKey) || active.has(bnd.dstKey);
        if (inside) a = Math.min(1, a * 1.5);
        else if (incident) a = Math.min(1, a * 1.3);
        else a *= 0.06; // context: dimmed, not gone
      }
      if (galaxyOf(bnd.srcKey) !== galaxyOf(bnd.dstKey)) {
        // (4) cross-repo brighten
        r = Math.min(1, r * 1.8);
        g = Math.min(1, g * 1.8);
        b = Math.min(1, b * 1.8);
      }
      plan.push({ srcKey: bnd.srcKey, dstKey: bnd.dstKey, r, g, b, a });
    }

    // (5) adaptive global opacity over the final drawn count.
    const k = adaptiveEdgeScale(plan.length);
    const geo = buildBundledGeometry(model, plan, store.bundleBeta, k);
    return { geometry: geo, drawn: plan.length, total };
  }, [
    model,
    store.expanded,
    store.selected,
    hovered,
    store.filters,
    store.audit,
    store.impact,
    store.focus,
    store.bundleBeta,
  ]);

  // Dispose the previous geometry when the memo recomputes (deps change). r3f
  // does NOT auto-dispose a manually `new`'d BufferGeometry, so without this the
  // old GPU buffer leaks on every expand / filter / hover-driven rebuild.
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Post-commit (never during render): publish the "showing N of M" readout.
  useEffect(() => {
    store.setEdgeStats({ drawn, total });
  }, [drawn, total]); // intentional: only republish when the stats change

  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    []
  );
  // Material is memoized with empty deps (built once), but dispose it on unmount
  // so its GPU program isn't leaked when the component goes away.
  useEffect(() => () => material.dispose(), [material]);

  return <lineSegments geometry={geometry} material={material} renderOrder={5} />;
}
