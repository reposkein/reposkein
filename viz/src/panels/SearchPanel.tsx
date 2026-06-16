import React, { useState, useRef, useEffect } from "react";
import { useStore } from "../state/store";
import { rankSearch, fieldLabel } from "../data/search";

/** Search panel (top area, next to HeaderBar). DETERMINISTIC ranked search
 *  (weighted-field scoring over name / qualified_name / file_path /
 *  semantic_summary). Results are ordered by relevance and show the matched
 *  field. Clicking a result expands its ancestor chain, selects it, and flies
 *  the camera to it. */
export function SearchPanel() {
  const store = useStore();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const model = store.model;

  const results = React.useMemo(() => {
    if (!model || query.trim().length < 2) return [];
    return rankSearch(model.records.values(), query, 10);
  }, [model, query]);

  useEffect(() => {
    setOpen(results.length > 0);
  }, [results]);

  function selectResult(id: string) {
    if (!model) return;
    const clusterKey = model.clusterOfNode.get(id) ?? id;
    // Walk ancestors and expand them so the node becomes visible.
    const chain = model.ancestors.get(clusterKey);
    if (chain) {
      for (const ak of chain) {
        const c = model.byKey.get(ak);
        // Expand non-leaf ancestors that are not yet expanded.
        if (c && c.children.length > 0 && !store.expanded.has(ak)) {
          store.toggleExpand(ak);
        }
      }
    }
    store.select(id);
    store.setFocusTarget(id);
    setQuery("");
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setQuery("");
      setOpen(false);
    }
    if (e.key === "Enter" && results.length > 0) selectResult(results[0]!.rec.id);
  }

  if (!model) return null;

  return (
    <div style={{ position: "relative", marginTop: 8, zIndex: 25 }}>
      <div style={{ position: "relative" }}>
        <input
          ref={inputRef}
          id="reposkein-search"
          type="text"
          placeholder="Search nodes… ( / )"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            background: "rgba(20,22,28,0.88)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 6,
            color: "#fff",
            padding: "5px 10px",
            fontSize: 12,
            width: 220,
            backdropFilter: "blur(8px)",
            outline: "none",
          }}
        />
        {open && results.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              right: 0,
              marginTop: 2,
              background: "rgba(20,22,28,0.95)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              overflow: "hidden",
              backdropFilter: "blur(8px)",
              maxHeight: 280,
              overflowY: "auto",
            }}
          >
            {results.map(({ rec, topField }) => (
              <div
                key={rec.id}
                onClick={() => selectResult(rec.id)}
                style={{
                  padding: "6px 10px",
                  cursor: "pointer",
                  fontSize: 12,
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.08)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 6,
                  }}
                >
                  <span style={{ color: "#fff", fontWeight: 500 }}>{rec.name}</span>
                  <span
                    style={{
                      color: "rgba(150,180,230,0.7)",
                      fontSize: 9,
                      flexShrink: 0,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                    }}
                  >
                    {fieldLabel(topField)}
                  </span>
                </div>
                <div
                  style={{
                    color: "rgba(255,255,255,0.4)",
                    fontSize: 10,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {rec.filePath}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
