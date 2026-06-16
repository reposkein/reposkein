import { useStore } from "../state/store";
import { LENS_ORDER, LENS_PRESETS } from "../data/lens";

/** One-click lens switcher (top-center). Each lens reconfigures the existing
 *  edge-type / node-kind filters + an emphasis flag via the store's setLens —
 *  it does NOT fork a parallel filtering path, and switching never moves the
 *  camera. The active lens is highlighted; a manual filter edit drops back to
 *  "All". */
export function LensSwitcher() {
  const store = useStore();
  return (
    <div
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "rgba(20,22,28,0.88)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 8,
        padding: "4px 6px",
        backdropFilter: "blur(8px)",
        zIndex: 25,
      }}
    >
      <span
        style={{
          fontSize: 10,
          letterSpacing: 1,
          opacity: 0.5,
          color: "#fff",
          padding: "0 4px",
        }}
      >
        LENS
      </span>
      {LENS_ORDER.map((id) => {
        const preset = LENS_PRESETS[id];
        const active = store.lens === id;
        return (
          <button
            key={id}
            onClick={() => store.setLens(id)}
            title={preset.hint}
            style={{
              background: active ? "rgba(97,175,239,0.28)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${active ? "#61afef" : "rgba(255,255,255,0.12)"}`,
              color: active ? "#cfe6ff" : "rgba(255,255,255,0.7)",
              borderRadius: 6,
              padding: "3px 10px",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: active ? 600 : 400,
              whiteSpace: "nowrap",
              transition: "all 0.12s",
            }}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
