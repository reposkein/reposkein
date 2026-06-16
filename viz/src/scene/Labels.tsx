import { useMemo } from "react";
import { Html } from "@react-three/drei";
import { useStore } from "../state/store";
import { visibleClusters } from "../data/clientModel";

/** Maximum number of cluster-level (dir/file) labels rendered when zoomed out. */
const MAX_CLUSTER_LABELS = 20;

/** Labels rendered in the 3D scene (billboarded HTML):
 *  - Always: hovered + selected nodes.
 *  - Adaptive: top-N cluster representatives (dir/file/galaxy) by child count
 *    (importance proxy) when cluster-level nodes are in view, so you can tell
 *    which crate/file is which without zooming in.
 *  Symbol names (stars) are shown only when hovered or selected. */
export function Labels() {
  const store = useStore();
  const model = store.model!;

  const targets = useMemo(() => {
    const visible = visibleClusters(model, store.expanded);

    // Always-on: hovered + selected.
    const priorityIds = new Set<string>();
    if (store.hovered) priorityIds.add(store.hovered);
    if (store.selected) priorityIds.add(store.selected);

    const out: { key: string; label: string; pos: [number, number, number]; priority: boolean }[] = [];

    // Priority labels (hovered/selected).
    for (const id of priorityIds) {
      const key = model.clusterOfNode.get(id) ?? id;
      const idx = model.indexByKey.get(key);
      if (idx === undefined) continue;
      const c = model.byKey.get(key);
      const label = c?.name ?? model.records.get(id)?.name ?? key;
      out.push({
        key: `priority-${key}`,
        label,
        pos: [
          model.positions[idx * 3]!,
          model.positions[idx * 3 + 1]!,
          model.positions[idx * 3 + 2]!,
        ],
        priority: true,
      });
    }

    // Adaptive cluster labels: show dir/file/galaxy names when at cluster LOD.
    // Sort visible clusters by child count descending (importance proxy), take top N.
    const clusterCandidates: { key: string; importance: number }[] = [];
    for (const key of visible) {
      const c = model.byKey.get(key);
      if (!c) continue;
      // Only show cluster-level labels (not symbols, those are too numerous).
      if (c.kind === "symbol") continue;
      clusterCandidates.push({ key, importance: c.children.length });
    }
    clusterCandidates.sort((a, b) => b.importance - a.importance);

    const priorityKeys = new Set(
      [...priorityIds].map((id) => model.clusterOfNode.get(id) ?? id)
    );

    let clusterCount = 0;
    for (const { key } of clusterCandidates) {
      if (clusterCount >= MAX_CLUSTER_LABELS) break;
      if (priorityKeys.has(key)) continue; // already in priority list
      const idx = model.indexByKey.get(key);
      if (idx === undefined) continue;
      const c = model.byKey.get(key)!;
      out.push({
        key: `cluster-${key}`,
        label: c.name,
        pos: [
          model.positions[idx * 3]!,
          model.positions[idx * 3 + 1]!,
          model.positions[idx * 3 + 2]!,
        ],
        priority: false,
      });
      clusterCount++;
    }

    return out;
  }, [model, store.hovered, store.selected, store.expanded]);

  return (
    <>
      {targets.map((t) => (
        <Html key={t.key} position={t.pos} center distanceFactor={40} zIndexRange={[10, 0]}>
          <div
            style={{
              padding: "2px 6px",
              borderRadius: 4,
              background: t.priority
                ? "rgba(8,12,24,0.92)"
                : "rgba(8,12,24,0.65)",
              border: t.priority
                ? "1px solid rgba(120,150,210,0.5)"
                : "1px solid rgba(120,150,210,0.25)",
              color: t.priority ? "#dfe6f5" : "rgba(180,200,230,0.7)",
              fontSize: t.priority ? 12 : 10,
              whiteSpace: "nowrap",
              pointerEvents: "none",
              transform: "translateY(-14px)",
            }}
          >
            {t.label}
          </div>
        </Html>
      ))}
    </>
  );
}
