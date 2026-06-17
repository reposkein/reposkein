import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../state/store";
import { visibleClusters } from "../data/clientModel";
import { buildCouplingLinks } from "../data/temporal";

/** Temporal-coupling overlay: dashed magenta links between FILE-level cluster
 *  representatives that change together (git-derived co-change). Rendered as a
 *  SEPARATE dashed LineSegments buffer, distinct from the structural edges, so
 *  it reads as an additive overlay and never touches the deterministic graph.
 *  Drawn only when the coupling toggle is on and the server returned data. */
export function TemporalLinks() {
  const store = useStore();
  const model = store.model!;
  const cochange = store.cochange;

  const geometry = useMemo(() => {
    if (!cochange) return null;
    const visible = visibleClusters(model, store.expanded);
    const links = buildCouplingLinks(model, cochange, visible);
    if (links.length === 0) return null;

    const positions: number[] = [];
    // Per-segment cumulative distances drive the dash pattern. For LineSegments
    // each segment is independent: [0, segmentLength] per pair.
    const lineDistances: number[] = [];
    for (const l of links) {
      const ai = model.indexByKey.get(l.aKey);
      const bi = model.indexByKey.get(l.bKey);
      if (ai === undefined || bi === undefined) continue;
      const ax = model.positions[ai * 3]!;
      const ay = model.positions[ai * 3 + 1]!;
      const az = model.positions[ai * 3 + 2]!;
      const bx = model.positions[bi * 3]!;
      const by = model.positions[bi * 3 + 1]!;
      const bz = model.positions[bi * 3 + 2]!;
      positions.push(ax, ay, az, bx, by, bz);
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      lineDistances.push(0, len);
    }
    if (positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("lineDistance", new THREE.Float32BufferAttribute(lineDistances, 1));
    return geo;
  }, [model, cochange, store.expanded]);

  // Dispose the previous (manually-`new`'d) geometry when it changes / unmounts;
  // r3f won't free it for us, so a re-derive would otherwise leak the GPU buffer.
  useEffect(() => {
    const g = geometry;
    return () => g?.dispose();
  }, [geometry]);

  const material = useMemo(
    () =>
      new THREE.LineDashedMaterial({
        color: 0xff3df0, // magenta — distinct from every structural hue
        transparent: true,
        opacity: 0.7,
        dashSize: 2.5,
        gapSize: 1.8,
        depthWrite: false,
      }),
    []
  );
  useEffect(() => () => material.dispose(), [material]);

  if (!store.coupling || !geometry) return null;
  return <lineSegments geometry={geometry} material={material} />;
}
