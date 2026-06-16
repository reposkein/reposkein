import { useState } from "react";
import { useStore } from "../state/store";

const KINDS = [
  { key: "function", label: "Function", color: "#e5c07b" },
  { key: "class", label: "Class", color: "#56b6c2" },
  { key: "interface", label: "Interface", color: "#c678dd" },
  { key: "enum", label: "Enum", color: "#98c379" },
  { key: "variable", label: "Variable", color: "#abb2bf" },
];

const EDGE_TYPES = ["CALLS", "IMPORTS", "INHERITS", "IMPLEMENTS", "INSTANTIATES"];

/** Collapsible filter HUD (bottom-right). Toggles symbol kind and edge type
 *  visibility, and controls the minimum confidence threshold for edges. */
export function FilterHUD() {
  const store = useStore();
  const [open, setOpen] = useState(true);
  const { filters, audit } = store;
  const hasFilters =
    filters.kinds.size > 0 ||
    filters.edgeTypes.size > 0 ||
    filters.minConfidence > 0 ||
    audit !== "off";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        background: "rgba(20,22,28,0.88)",
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(8px)",
        color: "#fff",
        fontSize: 12,
        width: 240,
        zIndex: 20,
      }}
    >
      {/* header row — click to toggle collapsed state */}
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
          FILTERS {hasFilters ? "●" : ""}
        </span>
        <span style={{ opacity: 0.5 }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ padding: "8px 10px" }}>
          {/* Node kind toggles */}
          <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4 }}>NODE KIND</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {KINDS.map(({ key, label, color }) => {
              const hidden = filters.kinds.has(key);
              return (
                <button
                  key={key}
                  onClick={() => store.setKindFilter(key, !hidden)}
                  style={{
                    background: hidden ? "rgba(255,255,255,0.05)" : color + "33",
                    border: `1px solid ${hidden ? "rgba(255,255,255,0.1)" : color + "88"}`,
                    color: hidden ? "rgba(255,255,255,0.3)" : color,
                    borderRadius: 12,
                    padding: "2px 8px",
                    cursor: "pointer",
                    fontSize: 11,
                    transition: "all 0.15s",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Edge type toggles */}
          <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4 }}>EDGE TYPE</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {EDGE_TYPES.map((type) => {
              const hidden = filters.edgeTypes.has(type);
              return (
                <button
                  key={type}
                  onClick={() => store.setEdgeTypeFilter(type, !hidden)}
                  style={{
                    background: hidden ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.1)",
                    border: `1px solid ${
                      hidden ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.25)"
                    }`,
                    color: hidden ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.8)",
                    borderRadius: 12,
                    padding: "2px 8px",
                    cursor: "pointer",
                    fontSize: 11,
                    transition: "all 0.15s",
                  }}
                >
                  {type}
                </button>
              );
            })}
          </div>

          {/* Confidence-audit mode (resolver-quality debugging). Shows ONLY
              low-confidence edges so you can SEE where the type-free resolver
              is guessing. */}
          <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4 }}>
            CONFIDENCE AUDIT {audit !== "off" ? "● ON" : ""}
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
            <AuditButton
              label="Ambiguous only"
              hint="Show ONLY ambiguous (guessed) edges; hide everything else"
              on={audit === "ambiguous"}
              onClick={() =>
                store.setAudit(audit === "ambiguous" ? "off" : "ambiguous")
              }
            />
            <AuditButton
              label="+ name_match"
              hint="Also include name_match edges (still low-confidence)"
              on={audit === "ambiguous+name"}
              onClick={() =>
                store.setAudit(audit === "ambiguous+name" ? "off" : "ambiguous+name")
              }
            />
          </div>
          {audit !== "off" && (
            <div
              style={{
                fontSize: 10,
                lineHeight: 1.4,
                color: "#ffb454",
                marginBottom: 8,
              }}
            >
              Showing only low-confidence edges — where the resolver is guessing.
            </div>
          )}

          {/* Confidence slider */}
          <div style={{ fontSize: 10, opacity: 0.5, marginBottom: 4 }}>
            MIN CONFIDENCE: {filters.minConfidence.toFixed(2)}
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={filters.minConfidence}
            onChange={(e) => store.setMinConfidence(parseFloat(e.target.value))}
            style={{ width: "100%", marginBottom: 8, accentColor: "#61afef" }}
          />

          {/* Reset button (only shown when any filter is active) */}
          {hasFilters && (
            <button
              onClick={() => store.clearFilters()}
              style={{
                width: "100%",
                padding: "4px 0",
                borderRadius: 4,
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "rgba(255,255,255,0.6)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Reset filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AuditButton({
  label,
  hint,
  on,
  onClick,
}: {
  label: string;
  hint: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={hint}
      style={{
        flex: 1,
        background: on ? "rgba(255,180,84,0.22)" : "rgba(255,255,255,0.05)",
        border: `1px solid ${on ? "#ffb454" : "rgba(255,255,255,0.12)"}`,
        color: on ? "#ffd9a0" : "rgba(255,255,255,0.65)",
        borderRadius: 6,
        padding: "3px 6px",
        cursor: "pointer",
        fontSize: 10,
        fontWeight: on ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}
