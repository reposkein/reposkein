import { useState } from "react";
import { EDGE_TYPE_META, NODE_KIND_META } from "../scene/encoding";

/** Collapsible legend panel (bottom-left). Single source of truth for colors
 *  comes from encoding.ts constants so legend + scene always agree. */
export function LegendPanel() {
  const [open, setOpen] = useState(true);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        left: 12,
        background: "rgba(20,22,28,0.88)",
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(8px)",
        color: "#fff",
        fontSize: 11,
        width: 180,
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "6px 10px",
          borderBottom: open ? "1px solid rgba(255,255,255,0.07)" : "none",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ fontWeight: 600, fontSize: 11, letterSpacing: 1, opacity: 0.8 }}>
          LEGEND
        </span>
        <span style={{ opacity: 0.5 }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ padding: "8px 10px" }}>
          <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4 }}>NODE KIND</div>
          {NODE_KIND_META.map(({ kind, color, label }) => (
            <div key={kind} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: color,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "rgba(255,255,255,0.75)" }}>{label}</span>
            </div>
          ))}

          <div style={{ fontSize: 10, opacity: 0.5, marginTop: 8, marginBottom: 4 }}>EDGE TYPE</div>
          {EDGE_TYPE_META.map(({ type, color, label }) => (
            <div key={type} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 18,
                  height: 2,
                  background: color,
                  flexShrink: 0,
                  borderRadius: 1,
                }}
              />
              <span style={{ color: "rgba(255,255,255,0.75)" }}>{label}</span>
            </div>
          ))}

          <div
            style={{
              marginTop: 8,
              fontSize: 10,
              opacity: 0.45,
              lineHeight: 1.4,
              borderTop: "1px solid rgba(255,255,255,0.07)",
              paddingTop: 6,
            }}
          >
            Edge opacity = confidence
          </div>
        </div>
      )}
    </div>
  );
}
