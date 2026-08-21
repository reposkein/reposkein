import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { useStore } from "../state/store";
import { MAX_FOCUS_DEPTH, MIN_FOCUS_DEPTH } from "../data/neighborhood";
import { buildMinConfidenceIndex, nodeConfidence } from "../data/nodeConfidence";
import { nodeKindColorVar } from "../data/encodingVars";
import { nodeKindGlyph } from "../data/nodeGlyph";
import { fetchSource, type SourceSlice } from "../data/api";
import { isStaticMode } from "../data/staticMode";
import { keyScopeProps } from "./globalKeys";
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

type ColumnId = "direction" | "type" | "neighbor" | "resolution" | "confidence";

const COLUMN_HEADER: Record<ColumnId, string> = {
  direction: "Dir",
  type: "Type",
  neighbor: "Neighbor",
  resolution: "Match",
  confidence: "Conf",
};

/** The INSPECTOR (Astrolabe V3 §1) — replaces DetailPanel.
 *
 *  A 360px right drawer that exists ONLY while something is selected. That is
 *  the point of the rewrite, not a detail: DetailPanel was permanently mounted
 *  and rendered a "Click a star to inspect it" placeholder card over the scene
 *  at all times, so the viewer's first impression of the constellation was a
 *  panel telling them what to do. Here, no selection means no drawer — the
 *  empty state is the absence of the surface (V3 §4), and `Inspector` returns
 *  null rather than rendering a shell.
 *
 *  OPAQUE, NOT BLURRED (V3 §6). The summoned layers may blur their backdrop
 *  because they're transient; the Inspector can stay open for minutes while you
 *  read a summary, and a persistent blur behind body text is a legibility tax.
 *  It shares the status bar's flat navy instead.
 *
 *  Structure: identity header (fixed) → scrolling body (overview, incident
 *  edges, source peek, semantic summary) → action footer (fixed). The footer is
 *  pinned so Impact / Focus are reachable without scrolling past a long summary,
 *  and every action there dispatches the SAME store action its command-palette
 *  twin does (`state/commands.ts`) — one code path, two entry points. */
export function Inspector() {
  const store = useStore();
  const model = store.model;
  const rec = model && store.selected ? model.records.get(store.selected) : null;

  // Drawer only exists on a live selection (see docstring): no empty state.
  if (!model || !rec) return null;

  return (
    <aside
      aria-label={`Inspector — ${rec.name || rec.id}`}
      data-testid="inspector"
      className="pointer-events-auto fixed right-0 top-0 bottom-7 z-[110] flex w-[360px] max-w-[calc(100vw-1rem)] flex-col border-l border-[rgba(148,163,207,0.18)] bg-[color-mix(in_srgb,var(--color-brand-navy)_96%,white_3%)] text-[13px] text-[var(--color-brand-cream)] shadow-[-12px_0_32px_-16px_rgba(0,0,0,0.8)] motion-safe:animate-[rs-drawer-in_180ms_ease-out]"
    >
      <IdentityHeader rec={rec} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <Overview rec={rec} />
        <IncidentEdges />
        <SourcePeek rec={rec} repoRoot={model.repoRoot} />
        <SummarySection rec={rec} />
      </div>
      <ActionRow />
    </aside>
  );
}

/** Name, kind badge, path, confidence — the four things that answer "what am I
 *  looking at" before any prose. The path is JetBrains Mono (V3 §8: ids, paths
 *  and counts are mono); the kind badge takes its hue from the same encoding
 *  token the star does. */
function IdentityHeader({ rec }: { rec: NodeRecord }) {
  const store = useStore();
  const model = store.model!;
  const confidenceIndex = useMemo(() => buildMinConfidenceIndex(model), [model]);
  const confidence = nodeConfidence(confidenceIndex, rec.id);
  const colorVar = nodeKindColorVar(rec.kind);
  const lines = rec.startLine > 0 ? `:${rec.startLine}-${rec.endLine}` : "";

  return (
    <header className="shrink-0 border-b border-[rgba(148,163,207,0.16)] px-3 py-2.5">
      <div className="flex items-start gap-2">
        <span
          aria-hidden="true"
          data-testid="inspector-kind-glyph"
          data-color-var={colorVar}
          className="mt-0.5 w-4 shrink-0 text-center text-[13px]"
          style={{ color: colorVar }}
        >
          {nodeKindGlyph(rec.kind)}
        </span>
        <h2
          data-testid="inspector-name"
          className="min-w-0 flex-1 break-words text-[15px] font-medium leading-snug"
        >
          {rec.name || rec.id}
        </h2>
        <button
          type="button"
          onClick={() => store.select(null)}
          aria-label="Close inspector"
          className="min-h-6 min-w-6 shrink-0 text-[13px] opacity-50 hover:opacity-100"
        >
          ✕
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {rec.kind && (
          <span
            data-testid="inspector-kind-badge"
            data-color-var={colorVar}
            style={{ color: colorVar, borderColor: colorVar }}
            className="rounded-full border bg-white/5 px-2 py-0.5 text-[11px]"
          >
            {rec.kind}
          </span>
        )}
        {confidence < 1 && (
          <span
            data-testid="inspector-confidence"
            title={`Touched by a low-confidence edge (${Math.round(confidence * 100)}%)`}
            className="rounded-full border border-[color-mix(in_srgb,var(--color-brand-amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_16%,transparent)] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-[var(--color-brand-amber)]"
          >
            {Math.round(confidence * 100)}% confidence
          </span>
        )}
      </div>
      {rec.filePath && (
        <p
          data-testid="inspector-path"
          title={`${rec.filePath}${lines}`}
          className="mt-1.5 truncate font-mono text-[11px] opacity-65"
        >
          {rec.filePath}
          {lines}
        </p>
      )}
    </header>
  );
}

/** The at-a-glance facts DetailPanel scattered across its header chips. */
function Overview({ rec }: { rec: NodeRecord }) {
  const rows: { label: string; value: string; mono?: boolean }[] = [];
  if (rec.qualifiedName && rec.qualifiedName !== rec.name) {
    rows.push({ label: "Qualified", value: rec.qualifiedName, mono: true });
  }
  if (rec.language) rows.push({ label: "Language", value: rec.language });
  if (rec.role) rows.push({ label: "Role", value: rec.role });
  if (rec.startLine > 0) {
    rows.push({ label: "Lines", value: `${rec.startLine}–${rec.endLine}`, mono: true });
  }
  rows.push({ label: "Connections", value: String(rec.degree), mono: true });

  return (
    <Section title="Overview">
      <dl className="flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-2">
            <dt className="w-24 shrink-0 text-[11px] uppercase tracking-wide opacity-45">
              {r.label}
            </dt>
            <dd
              className={`min-w-0 flex-1 break-words text-[13px] opacity-85 ${r.mono ? "font-mono text-[11px] tabular-nums" : ""}`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

/** Sortable, keyboard-operable incident-edge table.
 *
 *  DetailPanel's table was mouse-only in two ways: the sort affordance was an
 *  `onClick` on a bare `<th>`, and each row was an `onClick` `<tr>`. Neither was
 *  focusable, so a keyboard user could see the neighbors and reach none of them.
 *
 *  Here the sort affordance is a real `<button>` inside the `<th>` (with
 *  `aria-sort` on the header cell so the current order is announced), and the
 *  rows use ROVING TABINDEX: exactly one row is in the tab order at a time,
 *  ↑/↓/Home/End move it, Enter/Space navigates. That's one Tab stop for the
 *  whole table rather than one per neighbor — the standard grid pattern, and the
 *  reason a 200-edge hub doesn't become a 200-Tab wall.
 *
 *  The table declares `keyScopeProps` and its rows `stopPropagation`, because
 *  those same Arrow keys are ALSO Root's global "hop to the next neighbor"
 *  binding: without both, one ArrowDown moved the roving focus *and* jumped the
 *  selection to an unrelated node. See `panels/globalKeys.ts`. */
function IncidentEdges() {
  const store = useStore();
  const model = store.model!;
  const selected = store.selected;
  const [sorting, setSorting] = useState<SortingState>([]);
  const [activeRow, setActiveRow] = useState(0);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const incident = useMemo<IncidentRow[]>(() => {
    if (!selected) return [];
    const rows: IncidentRow[] = [];
    for (const e of model.drawEdges) {
      if (e.from === selected) {
        rows.push({
          direction: "out",
          type: e.type,
          neighborId: e.to,
          neighbor: model.records.get(e.to)?.name ?? e.to,
          resolution: e.resolution,
          confidence: e.confidence,
        });
      } else if (e.to === selected) {
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
  }, [model, selected]);

  const columns = useMemo(
    () => [
      col.accessor("direction", { header: COLUMN_HEADER.direction }),
      col.accessor("type", { header: COLUMN_HEADER.type }),
      col.accessor("neighbor", { header: COLUMN_HEADER.neighbor }),
      col.accessor("resolution", { header: COLUMN_HEADER.resolution }),
      col.accessor("confidence", { header: COLUMN_HEADER.confidence }),
    ],
    [],
  );

  const table = useReactTable({
    data: incident,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;

  // Re-seed the roving index when the data underneath it changes (a new
  // selection, or a re-sort that moves rows out from under the cursor).
  useEffect(() => {
    setActiveRow(0);
  }, [selected, sorting]);

  // Keep it in range if the row count shrinks.
  useEffect(() => {
    if (activeRow >= rows.length) setActiveRow(Math.max(0, rows.length - 1));
  }, [rows.length, activeRow]);

  function focusRow(index: number) {
    setActiveRow(index);
    bodyRef.current
      ?.querySelectorAll<HTMLElement>("[data-edge-row]")
      ?.[index]?.focus({ preventScroll: false });
  }

  function onRowKeyDown(e: ReactKeyboardEvent<HTMLTableRowElement>, index: number, id: string) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        focusRow(Math.min(rows.length - 1, index + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        focusRow(Math.max(0, index - 1));
        break;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        focusRow(0);
        break;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        focusRow(rows.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        store.revealAndSelect(id, { fly: true });
        break;
    }
    // Tab is deliberately NOT stopped: it must keep its normal "leave this
    // widget" focus behaviour. The global handler declines it instead, via the
    // `keyScopeProps` marker on the table below.
  }

  return (
    <Section title={`Incident edges (${incident.length})`}>
      {incident.length === 0 ? (
        <p className="text-[11px] opacity-50">No relationship edges touch this node.</p>
      ) : (
        <table
          data-testid="inspector-edges"
          {...keyScopeProps}
          className="w-full border-collapse text-left text-[11px]"
        >
          <caption className="sr-only">
            Relationship edges touching the selected node. Use the column buttons to sort; arrow
            keys move between rows and Enter opens a neighbor.
          </caption>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                      }
                      className="border-b border-[rgba(148,163,207,0.28)] p-0"
                    >
                      <button
                        type="button"
                        data-testid={`inspector-sort-${h.column.id}`}
                        onClick={h.column.getToggleSortingHandler()}
                        className="flex w-full items-center gap-0.5 px-1 py-1 text-left text-[11px] uppercase tracking-wide opacity-60 hover:opacity-100"
                      >
                        {COLUMN_HEADER[h.column.id as ColumnId]}
                        <span aria-hidden="true" className="opacity-70">
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((row, i) => {
              const r = row.original;
              return (
                <tr
                  key={row.id}
                  data-edge-row=""
                  data-testid="inspector-edge-row"
                  tabIndex={i === activeRow ? 0 : -1}
                  aria-label={`${r.direction === "out" ? "to" : "from"} ${r.neighbor}, ${r.type}, ${r.resolution}, confidence ${r.confidence.toFixed(2)}`}
                  onFocus={() => setActiveRow(i)}
                  onClick={() => store.revealAndSelect(r.neighborId, { fly: true })}
                  onKeyDown={(e) => onRowKeyDown(e, i, r.neighborId)}
                  className="cursor-pointer border-b border-[rgba(148,163,207,0.1)] hover:bg-white/5 focus:bg-white/10 focus:outline focus:outline-1 focus:outline-[var(--color-brand-amber)]"
                >
                  <td className="px-1 py-1 font-mono opacity-60">
                    {r.direction === "out" ? "→" : "←"}
                  </td>
                  <td className="px-1 py-1 opacity-80">{r.type}</td>
                  <td className="max-w-[7rem] truncate px-1 py-1" title={r.neighbor}>
                    {r.neighbor}
                  </td>
                  <td className="px-1 py-1 opacity-60">{r.resolution}</td>
                  <td className="px-1 py-1 font-mono tabular-nums opacity-70">
                    {r.confidence.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}

/** Read-only source peek. When the node carries a file path + line range, fetch
 *  that slice from the path-guarded /api/source endpoint. Degrades to rendering
 *  nothing (never blocks the rest of the drawer); hidden entirely in static
 *  export mode, where there is no server to ask. */
function SourcePeek({ rec, repoRoot }: { rec: NodeRecord; repoRoot: string | null }) {
  const [slice, setSlice] = useState<SourceSlice | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "missing">("idle");

  const hasSlice = !isStaticMode() && !!rec.filePath && rec.startLine > 0;

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

  // vscode://file/<abs>:<line>. The server returns POSIX-relative paths, so
  // join with the absolute repo root when it's known.
  const editorLink =
    repoRoot && rec.filePath
      ? `vscode://file/${repoRoot.replace(/\/+$/, "")}/${rec.filePath}:${rec.startLine || 1}`
      : null;

  return (
    <Section title="Source">
      {editorLink && (
        <a
          href={editorLink}
          title="Open this file at this line in VS Code"
          className="mb-1.5 inline-block text-[11px] text-[var(--color-brand-teal)] hover:opacity-80"
        >
          Open in editor ↗
        </a>
      )}
      {state === "loading" && <p className="text-[11px] opacity-50">Loading source…</p>}
      {state === "missing" && <p className="text-[11px] opacity-50">Source unavailable.</p>}
      {slice && (
        <pre className="m-0 max-h-56 overflow-auto rounded-[6px] border border-[rgba(148,163,207,0.16)] bg-black/35 px-2 py-1.5 font-mono text-[11px] leading-relaxed opacity-90">
          {slice.lines.map((line, i) => {
            const lineNo = slice.start + i;
            return (
              <div key={lineNo} className="flex whitespace-pre">
                <span className="inline-block w-10 shrink-0 select-none pr-2.5 text-right opacity-40">
                  {lineNo}
                </span>
                <span className="flex-1">{line || " "}</span>
              </div>
            );
          })}
        </pre>
      )}
    </Section>
  );
}

/** Semantic summary + the staleness warning (the summary was written against a
 *  content hash that no longer matches the file). */
function SummarySection({ rec }: { rec: NodeRecord }) {
  const stale =
    rec.semanticSummary !== null &&
    rec.summaryOfHash !== null &&
    rec.contentHash !== null &&
    rec.summaryOfHash !== rec.contentHash;

  return (
    <Section title="Semantic summary">
      {!rec.semanticSummary ? (
        <p className="text-[11px] opacity-50">No summary yet — agents write these as they explore.</p>
      ) : (
        <div>
          {stale && (
            <span
              data-testid="inspector-stale"
              title="The summary was written against an older version of this file"
              className="mb-1 inline-block rounded-full bg-[var(--color-brand-amber)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-brand-navy)]"
            >
              ⚠ Stale
            </span>
          )}
          {rec.semanticSummary.split(/\n\n+/).map((para, i) => (
            <p key={i} className="my-1 text-[13px] leading-relaxed opacity-90">
              {renderInlineCode(para)}
            </p>
          ))}
        </div>
      )}
    </Section>
  );
}

/** Backtick spans → <code>. Split on the capture group, so odd indices are the
 *  code contents. */
function renderInlineCode(text: string): ReactNode[] {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded-[3px] bg-white/10 px-1 font-mono text-[11px]">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** Impact + Focus (with its 1–3 depth control), pinned to the drawer's foot.
 *  Each button dispatches the identical store action its palette command does,
 *  so "Toggle impact overlay" from ⌘K and this button are the same transition —
 *  including the mode chip and the toast that follow from it. */
function ActionRow() {
  const store = useStore();
  const impactOn = store.impact !== null;
  const focusOn = store.focus !== null;
  const impacted = store.impact?.impacted.size ?? 0;
  const covering = store.impact?.coveringTests.size ?? 0;
  const focusCount = store.focus?.nodes.size ?? 0;

  return (
    <footer className="shrink-0 border-t border-[rgba(148,163,207,0.16)] px-3 py-2.5">
      <div className="flex gap-1.5">
        <ActionButton
          testId="inspector-impact"
          label={impactOn ? "Impact on" : "Impact"}
          title="Highlight transitive callers (reverse CALLS) and the tests covering them"
          on={impactOn}
          onClick={() => store.toggleImpact()}
        />
        <ActionButton
          testId="inspector-focus"
          label={focusOn ? "Focus on" : "Focus"}
          title="Isolate this symbol's N-hop neighborhood (in + out edges) and frame it"
          on={focusOn}
          onClick={() => store.toggleFocus()}
        />
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wide opacity-45">Depth</span>
        {Array.from({ length: MAX_FOCUS_DEPTH - MIN_FOCUS_DEPTH + 1 }, (_, i) => {
          const d = MIN_FOCUS_DEPTH + i;
          const on = store.focusDepth === d;
          return (
            <button
              key={d}
              type="button"
              data-testid={`inspector-depth-${d}`}
              onClick={() => store.setFocusDepth(d)}
              aria-pressed={on}
              title={`Trace ${d} hop${d === 1 ? "" : "s"} out from this symbol`}
              className={`min-h-6 min-w-6 rounded-[5px] border font-mono text-[11px] transition-colors ${
                on
                  ? "border-[color-mix(in_srgb,var(--color-brand-teal)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-teal)_16%,transparent)] text-[var(--color-brand-teal)]"
                  : "border-[rgba(148,163,207,0.2)] opacity-65 hover:opacity-100"
              }`}
            >
              {d}
            </button>
          );
        })}
        {focusOn && (
          <span className="ml-auto font-mono text-[11px] tabular-nums text-[var(--color-brand-teal)]">
            {focusCount} nodes
          </span>
        )}
      </div>

      {impactOn && (
        <p className="mt-1.5 flex gap-3 font-mono text-[11px] tabular-nums">
          <span className="text-[#ff8a73]">● {impacted} impacted</span>
          <span className="text-[#74ff8e]">
            ● {covering} covering test{covering === 1 ? "" : "s"}
          </span>
        </p>
      )}
    </footer>
  );
}

function ActionButton({
  label,
  title,
  on,
  onClick,
  testId,
}: {
  label: string;
  title: string;
  on: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`min-h-6 flex-1 rounded-[6px] border px-2 py-1 text-[11px] transition-colors ${
        on
          ? "border-[color-mix(in_srgb,var(--color-brand-amber)_55%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_16%,transparent)] text-[var(--color-brand-amber)]"
          : "border-[rgba(148,163,207,0.2)] opacity-75 hover:opacity-100"
      }`}
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-3 last:mb-0">
      <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wider opacity-45">{title}</h3>
      {children}
    </section>
  );
}
