import { useMemo } from "react";
import { Html } from "@react-three/drei";
import { useStore } from "../state/store";

/** Labels ONLY for the hovered and selected nodes (design §5: never thousands).
 *  Uses drei <Html> billboards anchored at the node's world position. */
export function Labels() {
  const store = useStore();
  const model = store.model!;

  const targets = useMemo(() => {
    const ids = new Set<string>();
    if (store.hovered) ids.add(store.hovered);
    if (store.selected) ids.add(store.selected);
    const out: { key: string; label: string; pos: [number, number, number] }[] = [];
    for (const id of ids) {
      // id may be a node id (symbol/file/dir) — find its cluster key.
      const key = model.clusterOfNode.get(id) ?? id;
      const idx = model.indexByKey.get(key);
      if (idx === undefined) continue;
      const c = model.byKey.get(key);
      const label = c?.name ?? model.records.get(id)?.name ?? key;
      out.push({
        key,
        label,
        pos: [
          model.positions[idx * 3]!,
          model.positions[idx * 3 + 1]!,
          model.positions[idx * 3 + 2]!,
        ],
      });
    }
    return out;
  }, [model, store.hovered, store.selected]);

  return (
    <>
      {targets.map((t) => (
        <Html key={t.key} position={t.pos} center distanceFactor={40} zIndexRange={[10, 0]}>
          <div
            style={{
              padding: "2px 6px",
              borderRadius: 4,
              background: "rgba(8,12,24,0.85)",
              border: "1px solid rgba(120,150,210,0.5)",
              color: "#dfe6f5",
              fontSize: 12,
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
