import { useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../state/store";
import { bundleEdges, filterDrawEdges, representativeFor, visibleClusters } from "../data/clientModel";
import { edgeColor, bundleOpacity } from "./encoding";

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
 *  (design §3.2 / §5). Raw edges are rolled up to the deepest currently-visible
 *  cluster representatives of their endpoints and AGGREGATED into per-pair
 *  bundles, so cluster↔cluster connections render at EVERY LOD — including the
 *  top level where only galaxy/dir cores are visible (the initial view shows a
 *  connected constellation). Self-loops are suppressed. Color encodes the
 *  bundle's dominant type; opacity encodes confidence/resolution with a
 *  minimum floor so connections are always visible. On hover, bundles not
 *  incident to the hovered representative are dimmed. One draw call. */
export function EdgeLines() {
  const store = useStore();
  const model = store.model!;
  const hovered = store.hovered;

  const geometry = useMemo(() => {
    const visible = visibleClusters(model, store.expanded);

    // Impact overlay: the set of node ids that participate (source + callers).
    const impactSet = store.impact
      ? new Set<string>([store.impact.sourceId, ...store.impact.impacted])
      : null;

    // Neighborhood focus: visible reps inside the focused region. Bundles wholly
    // inside it stay bright; everything else dims.
    let focusReps: Set<string> | null = null;
    if (store.focus) {
      focusReps = new Set<string>();
      for (const id of store.focus.nodes) {
        const r = representativeFor(model, id, visible);
        if (r) focusReps.add(r);
      }
    }

    // Apply edge type / confidence / audit filters before bundling (shared
    // gate so flow particles render on EXACTLY the same edges).
    const filteredModel = filterDrawEdges(model, {
      edgeTypes: store.filters.edgeTypes,
      minConfidence: store.filters.minConfidence,
      audit: store.audit,
    });

    const bundles = bundleEdges(filteredModel, visible);

    // Deepest visible representative of the hovered node (if any), used to
    // brighten incident bundles and dim the rest.
    const hoveredKey = hovered ? model.clusterOfNode.get(hovered) ?? hovered : null;
    let hoveredRep: string | null = null;
    if (hoveredKey) {
      const chain = model.ancestors.get(hoveredKey);
      if (!chain) {
        hoveredRep = visible.has(hoveredKey) ? hoveredKey : null;
      } else {
        for (let i = chain.length - 1; i >= 0; i--) {
          if (visible.has(chain[i]!)) {
            hoveredRep = chain[i]!;
            break;
          }
        }
      }
    }

    const positions: number[] = [];
    const colors: number[] = [];

    for (const b of bundles) {
      const si = model.indexByKey.get(b.srcKey);
      const di = model.indexByKey.get(b.dstKey);
      if (si === undefined || di === undefined) continue;

      let [r, g, bl] = edgeColor(b.dominantType);
      let a = bundleOpacity(b.bestResolution, b.count);

      // Impact overlay: brighten bundles whose CALLS edges connect two members
      // of the impact set (coral accent); dim everything else.
      if (impactSet) {
        const onImpactPath =
          b.dominantType === "CALLS" &&
          setHasAny(b.srcNodes, impactSet) &&
          setHasAny(b.dstNodes, impactSet);
        if (onImpactPath) {
          r = 1.0;
          g = 0.42;
          bl = 0.32;
          a = Math.min(1, a * 1.8);
        } else {
          a *= 0.08;
        }
      }

      // Neighborhood focus: dim bundles not wholly inside the focused region.
      if (focusReps) {
        const inside = focusReps.has(b.srcKey) && focusReps.has(b.dstKey);
        a = inside ? Math.min(1, a * 1.4) : a * 0.08;
      }

      // Hover focus: dim bundles not touching the hovered representative.
      if (hoveredRep) {
        const incident = b.srcKey === hoveredRep || b.dstKey === hoveredRep;
        a = incident ? Math.min(1, a * 1.6) : a * 0.12;
      }

      // Cross-repo bundles (galaxies differ) get a brighter colour to stand out.
      if (galaxyOf(b.srcKey) !== galaxyOf(b.dstKey)) {
        r = Math.min(1, r * 1.8);
        g = Math.min(1, g * 1.8);
        bl = Math.min(1, bl * 1.8);
      }

      // Pre-multiply color by opacity for additive blending.
      const cr = r * a;
      const cg = g * a;
      const cb = bl * a;

      positions.push(
        model.positions[si * 3]!,
        model.positions[si * 3 + 1]!,
        model.positions[si * 3 + 2]!,
        model.positions[di * 3]!,
        model.positions[di * 3 + 1]!,
        model.positions[di * 3 + 2]!
      );
      colors.push(cr, cg, cb, cr, cg, cb);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return geo;
  }, [model, store.expanded, hovered, store.filters, store.audit, store.impact, store.focus]);

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

  return <lineSegments geometry={geometry} material={material} />;
}
