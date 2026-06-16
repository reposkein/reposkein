import { useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../state/store";
import { representativeFor, visibleClusters } from "../data/clientModel";
import { edgeColor, edgeOpacity } from "./encoding";

/** Relationship edges as a SINGLE LineSegments buffer (design §5). Each drawn
 *  edge runs between the deepest currently-visible cluster representatives of
 *  its endpoints; self-loops (both endpoints in the same collapsed cluster)
 *  are suppressed. Color encodes edge type; per-vertex color is pre-multiplied
 *  by a confidence/resolution opacity factor (additive blending) so exact
 *  edges read bright/solid and ambiguous edges faint — one draw call. */
export function EdgeLines() {
  const store = useStore();
  const model = store.model!;

  const geometry = useMemo(() => {
    const visible = visibleClusters(model, store.expanded);
    const positions: number[] = [];
    const colors: number[] = [];

    for (const e of model.drawEdges) {
      const srcKey = representativeFor(model, e.from, visible);
      const dstKey = representativeFor(model, e.to, visible);
      if (!srcKey || !dstKey || srcKey === dstKey) continue; // suppress self-loops
      const si = model.indexByKey.get(srcKey);
      const di = model.indexByKey.get(dstKey);
      if (si === undefined || di === undefined) continue;

      const [r, g, b] = edgeColor(e.type);
      const a = edgeOpacity(e.resolution);
      // Pre-multiply color by opacity for additive blending.
      const cr = r * a;
      const cg = g * a;
      const cb = b * a;

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
  }, [model, store.expanded]);

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
