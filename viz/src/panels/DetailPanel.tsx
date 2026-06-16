import React, { useMemo } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
import { useEffect } from "react";
import { useStore } from "../state/store";
import { MIN_FOCUS_DEPTH, MAX_FOCUS_DEPTH } from "../data/neighborhood";
import { BRAND } from "../scene/encoding";
import { fetchSource, type SourceSlice } from "../data/api";
import type { NodeRecord } from "../data/model";

interface IncidentRow {
  direction: "out" | "in";
  type: string;
  neighborId: string;
  neighbor: string;
  resolution: string;
  confidence: number;
}

const col = createColumnHelper<IncidentRow>();

/** Click a node → detail panel: header (name, kind, file:lines, language,
 *  role), semantic_summary prose (+ staleness note), and a sortable TanStack
 *  Table of incident relationship edges. */
export function DetailPanel() {
  const store = useStore();
  const model = store.model!;
  const [sorting, setSorting] = useState<SortingState>([]);

  const rec = store.selected ? model.records.get(store.selected) : null;

  const incident = useMemo<IncidentRow[]>(() => {
    if (!store.selected) return [];
    const id = store.selected;
    const rows: IncidentRow[] = [];
    for (const e of model.drawEdges) {
      if (e.from === id) {
        rows.push({
          direction: "out",
          type: e.type,
          neighborId: e.to,
          neighbor: model.records.get(e.to)?.name ?? e.to,
          resolution: e.resolution,
          confidence: e.confidence,
        });
      } else if (e.to === id) {
        rows.push({
          direction: "in",
          type: e.type,
          neighborId: e.from,
          neighbor: model.records.get(e.from)?.name ?? e.from,
          resolution: e.resolution,
          confidence: e.confidence,
        });
      }
    }
    return rows;
  }, [model, store.selected]);

  function navigateToNode(id: string) {
    const clusterKey = model.clusterOfNode.get(id) ?? id;
    const chain = model.ancestors.get(clusterKey);
    if (chain) {
      for (const ak of chain) {
        const c = model.byKey.get(ak);
        if (c && c.children.length > 0 && !store.expanded.has(ak)) {
          store.toggleExpand(ak);
        }
      }
    }
    store.select(id);
    store.setFocusTarget(id);
  }

  const columns = useMemo(
    () => [
      col.accessor("direction", { header: "dir" }),
      col.accessor("type", { header: "type" }),
      col.accessor("neighbor", { header: "neighbor" }),
      col.accessor("resolution", { header: "resolution" }),
      col.accessor("confidence", { header: "conf" }),
    ],
    []
  );

  const table = useReactTable({
    data: incident,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (!rec) {
    return (
      <Shell>
        <div style={{ opacity: 0.6, fontSize: 13 }}>
          Click a star to inspect it. Click a cluster (galaxy / directory /
          file) to expand or collapse it.
        </div>
      </Shell>
    );
  }

  const stale =
    rec.semanticSummary !== null &&
    rec.summaryOfHash !== null &&
    rec.contentHash !== null &&
    rec.summaryOfHash !== rec.contentHash;

  return (
    <Shell>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>{rec.name || rec.id}</strong>
        {rec.kind && <Chip>{rec.kind}</Chip>}
        {rec.language && <Chip>{rec.language}</Chip>}
        {rec.role && <Chip>{rec.role}</Chip>}
      </div>
      {rec.qualifiedName && rec.qualifiedName !== rec.name && (
        <div style={{ fontSize: 12, opacity: 0.7 }}>{rec.qualifiedName}</div>
      )}
      {rec.filePath && (
        <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
          {rec.filePath}
          {rec.startLine ? `:${rec.startLine}-${rec.endLine}` : ""}
        </div>
      )}

      <FocusControl />
      <ImpactControl />

      <SourcePeek rec={rec} repoRoot={model.repoRoot} />

      <Section title="Semantic summary">
        <SummaryBlock summary={rec.semanticSummary} stale={stale} />
      </Section>

      <Section title={`Incident edges (${incident.length})`}>
        {incident.length === 0 ? (
          <div style={{ fontSize: 12, opacity: 0.55 }}>No relationship edges.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th
                      key={h.id}
                      onClick={h.column.getToggleSortingHandler()}
                      style={{
                        textAlign: "left",
                        cursor: "pointer",
                        borderBottom: "1px solid rgba(120,150,210,0.3)",
                        padding: "3px 4px",
                        userSelect: "none",
                      }}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => navigateToNode(row.original.neighborId)}
                  style={{ cursor: "pointer" }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} style={{ padding: "3px 4px", borderBottom: "1px solid rgba(120,150,210,0.12)" }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </Shell>
  );
}

/** Read-only source peek (design §P3). When the selected node carries a
 *  file_path + start/end lines, fetch that slice from the path-guarded
 *  /api/source endpoint and render it in a dimmed, scrollable monospace block
 *  with line numbers. An "Open in editor" link uses vscode://file/<abs>:<line>
 *  built from the served repo root. Degrades gracefully (renders nothing) when
 *  the source is unavailable — never blocks the rest of the panel. */
function SourcePeek({ rec, repoRoot }: { rec: NodeRecord; repoRoot: string | null }) {
  const [slice, setSlice] = useState<SourceSlice | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "missing">("idle");

  const hasSlice = !!rec.filePath && rec.startLine > 0;

  useEffect(() => {
    if (!hasSlice) {
      setSlice(null);
      setState("idle");
      return;
    }
    let cancelled = false;
    setState("loading");
    setSlice(null);
    const end = rec.endLine >= rec.startLine ? rec.endLine : rec.startLine;
    void fetchSource(rec.filePath, rec.startLine, end).then((s) => {
      if (cancelled) return;
      if (s && s.lines.length > 0) {
        setSlice(s);
        setState("idle");
      } else {
        setState("missing");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rec.id, rec.filePath, rec.startLine, rec.endLine, hasSlice]);

  if (!hasSlice) return null;

  // Build a vscode://file/<abs>:<line> link from the repo root (when known).
  // The server returns POSIX-relative paths; join with the abs root.
  const editorLink =
    repoRoot && rec.filePath
      ? `vscode://file/${repoRoot.replace(/\/+$/, "")}/${rec.filePath}:${rec.startLine || 1}`
      : null;

  return (
    <Section title="Source">
      {editorLink && (
        <a
          href={editorLink}
          style={{
            fontSize: 11,
            color: BRAND.teal,
            textDecoration: "none",
            display: "inline-block",
            marginBottom: 6,
          }}
          title="Open this file at this line in VS Code"
        >
          Open in editor ↗
        </a>
      )}
      {state === "loading" && (
        <div style={{ fontSize: 11, opacity: 0.5 }}>Loading source…</div>
      )}
      {state === "missing" && (
        <div style={{ fontSize: 11, opacity: 0.5 }}>Source unavailable.</div>
      )}
      {slice && (
        <pre
          style={{
            margin: 0,
            maxHeight: 220,
            overflow: "auto",
            background: "rgba(0,0,0,0.35)",
            border: "1px solid rgba(120,150,210,0.18)",
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 11,
            lineHeight: 1.45,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            color: "rgba(220,228,245,0.78)",
            opacity: 0.92,
          }}
        >
          {slice.lines.map((line, i) => {
            const lineNo = slice.start + i;
            return (
              <div key={lineNo} style={{ display: "flex", whiteSpace: "pre" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: 40,
                    flexShrink: 0,
                    textAlign: "right",
                    paddingRight: 10,
                    color: "rgba(120,140,180,0.5)",
                    userSelect: "none",
                  }}
                >
                  {lineNo}
                </span>
                <span style={{ flex: 1 }}>{line || " "}</span>
              </div>
            );
          })}
        </pre>
      )}
    </Section>
  );
}

/** Neighborhood focus: isolates the selected node's N-hop neighborhood over
 *  BOTH out- and in-edges (the "show me this symbol and everything it touches"
 *  view, get_context_profile analogue). Members stay bright; everything else
 *  dims; the camera refits to the region. A small depth control (1–3) bounds
 *  the BFS. Distinct from Impact (callers-only, unbounded). */
function FocusControl() {
  const store = useStore();
  const active = store.focus !== null;
  const count = store.focus?.nodes.size ?? 0;
  const depth = store.focusDepth;
  const teal = BRAND.teal;

  return (
    <div style={{ marginTop: 10 }}>
      <button
        onClick={() => store.toggleFocus()}
        title="Isolate this symbol's N-hop neighborhood (in + out edges) and frame it"
        style={{
          width: "100%",
          padding: "5px 0",
          borderRadius: 6,
          background: active ? `${teal}33` : "rgba(255,255,255,0.05)",
          border: `1px solid ${active ? teal : "rgba(255,255,255,0.14)"}`,
          color: active ? "#a9f0e6" : "rgba(255,255,255,0.75)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: active ? 600 : 400,
        }}
      >
        {active ? "Focus ON — click to clear" : "Focus neighborhood"}
      </button>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
          fontSize: 11,
          opacity: active ? 1 : 0.7,
        }}
      >
        <span style={{ opacity: 0.7 }}>Depth</span>
        {Array.from({ length: MAX_FOCUS_DEPTH - MIN_FOCUS_DEPTH + 1 }, (_, i) => {
          const d = MIN_FOCUS_DEPTH + i;
          const on = depth === d;
          return (
            <button
              key={d}
              onClick={() => store.setFocusDepth(d)}
              style={{
                width: 24,
                height: 22,
                borderRadius: 5,
                background: on ? `${teal}33` : "rgba(255,255,255,0.05)",
                border: `1px solid ${on ? teal : "rgba(255,255,255,0.14)"}`,
                color: on ? "#a9f0e6" : "rgba(255,255,255,0.6)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: on ? 700 : 400,
              }}
            >
              {d}
            </button>
          );
        })}
        {active && (
          <span style={{ marginLeft: "auto", color: "#a9f0e6" }}>
            {count} node{count === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}

/** Impact overlay toggle + counts. Computes transitive reverse-CALLS callers
 *  of the selected node and the covering tests among them; highlights them in
 *  the scene (coral = impacted, green = covering test) and dims the rest. */
function ImpactControl() {
  const store = useStore();
  const active = store.impact !== null;
  const impactedCount = store.impact?.impacted.size ?? 0;
  const coveringCount = store.impact?.coveringTests.size ?? 0;

  return (
    <div style={{ marginTop: 10 }}>
      <button
        onClick={() => store.toggleImpact()}
        title="Highlight transitive callers (reverse CALLS) and covering tests"
        style={{
          width: "100%",
          padding: "5px 0",
          borderRadius: 6,
          background: active ? "rgba(255,107,82,0.22)" : "rgba(255,255,255,0.05)",
          border: `1px solid ${active ? "#ff6b52" : "rgba(255,255,255,0.14)"}`,
          color: active ? "#ffb9ab" : "rgba(255,255,255,0.75)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: active ? 600 : 400,
        }}
      >
        {active ? "Impact ON — click to clear" : "Impact"}
      </button>
      {active && (
        <div style={{ display: "flex", gap: 8, marginTop: 6, fontSize: 11 }}>
          <span style={{ color: "#ff8a73" }}>
            ● {impactedCount} impacted
          </span>
          <span style={{ color: "#74ff8e" }}>
            ● {coveringCount} covering test{coveringCount === 1 ? "" : "s"}
          </span>
        </div>
      )}
    </div>
  );
}

/** Renders the semantic summary with inline code highlighting and stale badge. */
function SummaryBlock({
  summary,
  stale,
}: {
  summary: string | null;
  stale: boolean;
}) {
  if (!summary) {
    return (
      <div style={{ fontSize: 12, opacity: 0.55 }}>
        No summary yet — agents write these as they explore.
      </div>
    );
  }

  // Split summary into paragraphs, then render inline code spans.
  const paragraphs = summary.split(/\n\n+/);

  function renderInlineCode(text: string): React.ReactNode[] {
    const parts = text.split(/`([^`]+)`/);
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <code
          key={i}
          style={{
            background: "rgba(255,255,255,0.1)",
            borderRadius: 3,
            padding: "0 3px",
            fontFamily: "monospace",
          }}
        >
          {part}
        </code>
      ) : (
        part
      )
    );
  }

  return (
    <div>
      {stale && (
        <span
          style={{
            display: "inline-block",
            background: "#ffb454",
            color: "#000",
            borderRadius: 10,
            padding: "1px 7px",
            fontSize: 10,
            fontWeight: 700,
            marginBottom: 4,
          }}
        >
          ⚠ STALE
        </span>
      )}
      {paragraphs.map((para, i) => (
        <p key={i} style={{ margin: "4px 0", fontSize: 13, lineHeight: 1.5 }}>
          {renderInlineCode(para)}
        </p>
      ))}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        width: 360,
        maxHeight: "calc(100vh - 24px)",
        overflowY: "auto",
        padding: 14,
        borderRadius: 8,
        background: "rgba(8,11,22,0.92)",
        border: "1px solid rgba(90,120,180,0.35)",
        backdropFilter: "blur(4px)",
      }}
    >
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.6 }}>
        {title}
      </div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 999,
        background: "rgba(90,120,180,0.25)",
        border: "1px solid rgba(120,150,210,0.4)",
      }}
    >
      {children}
    </span>
  );
}
