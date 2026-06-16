import { useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../state/store";
import { visibleClusters } from "../data/clientModel";
import { constellationMst, type ConstellationPoint } from "./constellation";
import { BRAND_RGB } from "./encoding";

/** Per-cluster cap: the MST is dense O(n²); skip drawing star-sign lines inside
 *  any expanded cluster with more than this many visible members so a huge
 *  directory never costs a frame. (Cap chosen so the worst-case per-cluster
 *  work stays trivial even on the ~10k design target.) */
const MAX_MEMBERS_PER_CLUSTER = 80;

/** Faint "star-sign" connector lines inside expanded clusters: a deterministic
 *  minimum spanning tree over each expanded cluster's visible member positions,
 *  drawn as ONE additive LineSegments buffer in a cool, very low-opacity tint.
 *
 *  These are decorative (the constellation metaphor) and deliberately distinct
 *  from the real typed edges: fainter, cooler (brand teal), and only WITHIN a
 *  cluster's own members. LOD-gated to currently-expanded clusters and capped
 *  per cluster, so the pass stays cheap. Deterministic (MST, no randomness);
 *  render-time only. */
export function ConstellationLines() {
  const store = useStore();
  const model = store.model!;

  const geometry = useMemo(() => {
    const visible = visibleClusters(model, store.expanded);

    const positions: number[] = [];

    for (const parentKey of store.expanded) {
      const parent = model.byKey.get(parentKey);
      if (!parent || parent.children.length < 2) continue;

      // Direct children that are themselves currently rendered (a visible
      // representative): collapsed cores and leaf stars sitting in this cluster.
      const members: ConstellationPoint[] = [];
      for (const childKey of parent.children) {
        if (!visible.has(childKey)) continue; // child is itself expanded → skip
        const idx = model.indexByKey.get(childKey);
        if (idx === undefined) continue;
        members.push({
          key: childKey,
          x: model.positions[idx * 3]!,
          y: model.positions[idx * 3 + 1]!,
          z: model.positions[idx * 3 + 2]!,
        });
        if (members.length > MAX_MEMBERS_PER_CLUSTER) break;
      }
      if (members.length < 2 || members.length > MAX_MEMBERS_PER_CLUSTER) continue;

      const tree = constellationMst(members);
      for (const [i, j] of tree) {
        const a = members[i]!;
        const b = members[j]!;
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [model, store.expanded]);

  const material = useMemo(() => {
    const [r, g, b] = BRAND_RGB.teal;
    // Pre-multiply by a low alpha for additive blending: a cool faint web that
    // reads well below the real typed edges.
    const a = 0.06;
    return new THREE.LineBasicMaterial({
      color: new THREE.Color(r * a, g * a, b * a),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
  }, []);

  return <lineSegments geometry={geometry} material={material} raycast={() => null} />;
}
