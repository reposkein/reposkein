import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useStore } from "../state/store";
import { registerPaletteOpener, setCommandPaletteOpen } from "./paletteOpenState";
import { toggleLayer } from "./layerState";
import { pushToast } from "./toastState";
import { buildCommandRegistry, pushRecent, type CommandItem, type RecentEntry } from "../state/commands";
import { rankSearch, searchBucket, type SearchBucket } from "../data/search";
import { buildMinConfidenceIndex, nodeConfidence } from "../data/nodeConfidence";
import { nodeKindGlyph, nodeKindColorVar } from "../data/nodeGlyph";
import { captureScreenshot } from "../scene/Screenshot";

const FOCUSABLE =
  'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const RECENT_CAP = 8;
const MIN_QUERY_LEN = 2;
const MAX_NODE_HITS = 24;
const MAX_PER_BUCKET = 6;

type NodeGroup = "recent" | SearchBucket;

interface NodeRowData {
  kind: "node";
  group: NodeGroup;
  id: string;
  name: string;
  nodeKind: string;
  filePath: string;
}

interface CommandRowData {
  kind: "command";
  group: "commands";
  cmd: CommandItem;
  disabled: boolean;
}

type Row = NodeRowData | CommandRowData;

const GROUP_LABEL: Record<Row["group"], string> = {
  recent: "Recent",
  symbols: "Symbols",
  files: "Files",
  directories: "Directories",
  commands: "Commands",
};

const GROUP_ORDER: Row["group"][] = ["recent", "symbols", "files", "directories", "commands"];

function isRowDisabled(row: Row): boolean {
  return row.kind === "command" && row.disabled;
}

/** ⌘K / Ctrl+K / `/` command palette (REP-13, extended in Astrolabe V3). It
 *  owns its own open state, its own global hotkey listener, and its own query —
 *  nothing here reaches into the reducer until a row is actually executed.
 *  That's the whole perf contract: every keystroke is a LOCAL setState, so it
 *  re-renders only this component's own subtree, never the R3F scene consumers
 *  living inside <Canvas> (see the "perf (keystrokes stay local, never
 *  dispatch)" describe block in `CommandPalette.test.tsx` for a spy-based proof
 *  — no store action fires while typing or arrow-key traversing).
 *
 *  V3: the standalone SearchPanel is gone and this palette absorbed it. `/` now
 *  summons the palette (via `registerPaletteOpener` — Root's key handler used to
 *  focus the retired search input by DOM id), which is why the placeholder reads
 *  "Search or type > for commands". Nothing was lost in that migration: the
 *  palette ranks with the same `rankSearch` over the same records, keeps the
 *  same 2-character floor, and additionally groups by symbol/file/directory,
 *  shows confidence badges, and offers ⌘↵ reveal-without-flying.
 *
 *  Skeleton informed by the licensed React Bits Pro `command-menu-1` App UI
 *  block (Ultimate tier — REACTBITS_LICENSE_KEY is configured): its listbox
 *  a11y wiring (role=listbox/option, aria-activedescendant, Tab-trap, scroll
 *  handling) is reused; every visual and data concern below — groups,
 *  encoding-token colors, JetBrains Mono paths, confidence badges, the
 *  command registry, `>` command-only mode, and the no-results quick filter —
 *  is REP-13-specific and does not exist in the stock block. */
export function CommandPalette() {
  const store = useStore();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [filesOnly, setFilesOnly] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const model = store.model;

  const commands = useMemo(() => buildCommandRegistry(), []);
  const confidenceIndex = useMemo(
    () => (model ? buildMinConfidenceIndex(model) : new Map<string, number>()),
    [model],
  );

  const isCommandMode = query.startsWith(">");
  const commandQuery = (isCommandMode ? query.slice(1) : query).trim().toLowerCase();
  const nodeQuery = query.trim();

  const close = useCallback(() => {
    setOpen(false);
    setCommandPaletteOpen(false);
    setQuery("");
    setFilesOnly(false);
    setActiveIndex(0);
    restoreFocusRef.current?.focus({ preventScroll: true });
  }, []);

  const openPalette = useCallback(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    setOpen(true);
    setCommandPaletteOpen(true);
  }, []);

  // Safety net: if this component ever unmounts while open (route change,
  // test teardown), don't leave the singleton stuck reporting "open" forever.
  useEffect(() => () => setCommandPaletteOpen(false), []);

  // Publish the imperative opener so Root's `/` binding can summon the palette
  // without the palette's open state having to live in the reducer.
  useEffect(() => {
    registerPaletteOpener(openPalette);
    return () => registerPaletteOpener(null);
  }, [openPalette]);

  // Global ⌘K / Ctrl+K — works regardless of what currently has focus,
  // independent of Root.tsx's own keydown effect (which owns `/`).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else openPalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close, openPalette]);

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Node search: mirrors SearchPanel's 2-char floor. Skipped entirely in `>`
  // command-only mode. "Search files only" (from the no-results state)
  // restricts the pool to file records before ranking.
  const nodeBuckets = useMemo(() => {
    const empty = { symbols: [] as NodeRowData[], files: [] as NodeRowData[], directories: [] as NodeRowData[] };
    if (isCommandMode || !model || nodeQuery.length < MIN_QUERY_LEN) return empty;
    const pool = filesOnly
      ? [...model.records.values()].filter((r) => r.kind === "file")
      : model.records.values();
    const hits = rankSearch(pool, nodeQuery, MAX_NODE_HITS);
    const out = empty;
    for (const h of hits) {
      const bucket = searchBucket(h.rec.kind);
      if (out[bucket].length >= MAX_PER_BUCKET) continue;
      out[bucket].push({
        kind: "node",
        group: bucket,
        id: h.rec.id,
        name: h.rec.name || h.rec.id,
        nodeKind: h.rec.kind,
        filePath: h.rec.filePath,
      });
    }
    return out;
  }, [isCommandMode, model, nodeQuery, filesOnly]);

  const recentRows = useMemo<NodeRowData[]>(() => {
    if (isCommandMode) return [];
    const q = nodeQuery.toLowerCase();
    return recent
      .filter((r) => q.length === 0 || r.name.toLowerCase().includes(q) || r.filePath.toLowerCase().includes(q))
      .map((r) => ({ kind: "node" as const, group: "recent" as const, id: r.id, name: r.name, nodeKind: r.kind, filePath: r.filePath }));
  }, [isCommandMode, recent, nodeQuery]);

  const commandRows = useMemo<CommandRowData[]>(() => {
    return commands
      .filter((cmd) => {
        if (commandQuery.length === 0) return true;
        const haystack = `${cmd.label} ${cmd.subtitle ?? ""}`.toLowerCase();
        return haystack.includes(commandQuery);
      })
      .map((cmd) => ({ kind: "command" as const, group: "commands" as const, cmd, disabled: cmd.disabled(store) }));
  }, [commands, commandQuery, store]);

  const grouped = useMemo(() => {
    const map: Record<Row["group"], Row[]> = {
      recent: recentRows,
      symbols: nodeBuckets.symbols,
      files: nodeBuckets.files,
      directories: nodeBuckets.directories,
      commands: commandRows,
    };
    return GROUP_ORDER.map((g) => ({ group: g, rows: map[g] })).filter((g) => g.rows.length > 0);
  }, [recentRows, nodeBuckets, commandRows]);

  const flatRows = useMemo<Row[]>(() => grouped.flatMap((g) => g.rows), [grouped]);
  const noResults = flatRows.length === 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, filesOnly]);

  // Keep activeIndex in range as the result set shrinks (e.g. a keystroke
  // trims the list out from under a high index).
  useEffect(() => {
    if (activeIndex >= flatRows.length) setActiveIndex(Math.max(0, flatRows.length - 1));
  }, [flatRows.length, activeIndex]);

  useEffect(() => {
    const scroller = listRef.current;
    const row = scroller?.querySelector<HTMLElement>('[data-active="true"]');
    if (!scroller || !row) return;
    const listBox = scroller.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < listBox.top) scroller.scrollTop -= listBox.top - rowBox.top;
    else if (rowBox.bottom > listBox.bottom) scroller.scrollTop += rowBox.bottom - listBox.bottom;
  }, [activeIndex]);

  function moveActive(delta: number) {
    const n = flatRows.length;
    if (n === 0) return;
    let next = activeIndex;
    for (let i = 0; i < n; i++) {
      next = (next + delta + n) % n;
      if (!isRowDisabled(flatRows[next]!)) break;
    }
    setActiveIndex(next);
  }

  const env = useMemo(
    () => ({
      screenshot: () => {
        captureScreenshot();
        // The capture itself is fire-and-forget inside the scene (a canvas
        // toBlob + anchor click), so there is no promise to await — the toast
        // reports that the download was STARTED, which is the honest claim.
        pushToast("Screenshot saved", { tone: "accent", dedupeKey: "screenshot" });
      },
      copyLink: () => {
        try {
          void navigator.clipboard?.writeText(window.location.href);
          pushToast("Link copied", { tone: "accent", dedupeKey: "copy-link" });
        } catch {
          /* best-effort — clipboard permission or API absence is not fatal. */
          pushToast("Couldn't copy the link", { tone: "warn", dedupeKey: "copy-link" });
        }
      },
      toggleLayer,
    }),
    [],
  );

  const executeRow = useCallback(
    (row: Row | undefined, opts: { fly: boolean }) => {
      if (!row || isRowDisabled(row)) return;
      if (row.kind === "command") {
        row.cmd.run(store, store, env);
        close();
        return;
      }
      setRecent((prev) =>
        pushRecent(prev, { id: row.id, name: row.name, kind: row.nodeKind, filePath: row.filePath }, RECENT_CAP),
      );
      store.revealAndSelect(row.id, { fly: opts.fly });
      close();
    },
    [store, env, close],
  );

  function onInputKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Enter":
        e.preventDefault();
        executeRow(flatRows[activeIndex], { fly: !(e.metaKey || e.ctrlKey) });
        break;
      case "Escape":
        e.preventDefault();
        // See onDialogKeyDown for why this must stop propagating.
        e.stopPropagation();
        close();
        break;
    }
  }

  function onDialogKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      // STOP THE ESC HERE (V4 §1, fix round 1 `C1`). The palette is the top of
      // the Esc stack, but it is the ONE step that cannot announce that by
      // being asked: `LayerShell` and the status bar's chip handler are
      // capture-phase window listeners that call `stopImmediatePropagation`,
      // whereas this is a React handler on the dialog, so without an explicit
      // stop the native event keeps bubbling to the window listener in
      // `routes/Root.tsx`.
      //
      // That listener asks `isCommandPaletteOpen()` — and `close()` below has
      // already flipped the singleton to false by the time the event arrives.
      // So one Esc closed the palette AND ran the next rung of the ladder:
      // through V3 a collapse, after V4 a deselect. The singleton guard alone
      // cannot fix it, because the state it reads changes mid-dispatch; only
      // consuming the event can.
      //
      // BOTH handlers need it: the input's own keydown never reaches this one,
      // and focus sits on a row rather than the input as soon as the reader
      // clicks or tabs into the list.
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const focused = root.ownerDocument.activeElement;
    if (e.shiftKey && focused === first) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && focused === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  if (!open) return null;

  const listboxId = `${uid}-listbox`;
  const activeRow = flatRows[activeIndex];
  const activeRowId = activeRow ? `${uid}-row-${activeIndex}` : undefined;
  const statusMessage = noResults
    ? isCommandMode
      ? `No commands match "${commandQuery}"`
      : `No matches for "${query}"`
    : `${flatRows.length} result${flatRows.length === 1 ? "" : "s"}`;

  let runningIndex = -1;

  return (
    <>
      <div
        aria-hidden="true"
        onMouseDown={close}
        className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onDialogKeyDown}
        className="fixed left-1/2 top-[12%] z-[201] flex max-h-[70vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-[10px] border border-[rgba(148,163,207,0.14)] bg-[color-mix(in_srgb,var(--color-brand-navy)_96%,white_4%)] text-[13px] text-[var(--color-brand-cream)] shadow-[0_16px_48px_-12px_rgba(0,0,0,0.55)] backdrop-blur-md"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[rgba(148,163,207,0.14)] px-3 py-2.5">
          <span aria-hidden="true" className="text-[13px] opacity-50">
            ⌘K
          </span>
          <label htmlFor={`${uid}-input`} className="sr-only">
            Search symbols, files, directories, or type &gt; for commands
          </label>
          <input
            ref={inputRef}
            id={`${uid}-input`}
            role="combobox"
            aria-expanded={!noResults}
            aria-controls={listboxId}
            aria-activedescendant={activeRowId}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search or type > for commands…"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-brand-cream)] placeholder:opacity-70 focus:outline-none"
          />
          {filesOnly && (
            <button
              type="button"
              onClick={() => setFilesOnly(false)}
              className="shrink-0 rounded-full border border-[rgba(148,163,207,0.25)] px-2 py-0.5 text-[11px] opacity-75 hover:opacity-100"
            >
              Files only ✕
            </button>
          )}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {/* Always rendered (even empty) so `aria-controls` on the combobox
           *  input never dangles — it used to reference this id only when
           *  results existed, which is an axe violation the moment the list
           *  is empty. NoResults renders as a SIBLING, not inside it, so the
           *  listbox stays a real (if empty) listbox rather than switching
           *  role entirely. */}
          <div id={listboxId} role="listbox" aria-label="Results">
            {!noResults &&
              grouped.map(({ group, rows }) => (
                <div key={group} role="group" aria-label={GROUP_LABEL[group]} className="mb-1 last:mb-0">
                  <p className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider opacity-70">
                    {GROUP_LABEL[group]}
                  </p>
                  {rows.map((row) => {
                    runningIndex += 1;
                    const index = runningIndex;
                    return (
                      <Row
                        key={`${row.group}-${row.kind === "command" ? row.cmd.id : row.id}`}
                        rowId={`${uid}-row-${index}`}
                        row={row}
                        active={index === activeIndex}
                        confidenceIndex={confidenceIndex}
                        onHover={() => setActiveIndex(index)}
                        onCommit={(fly) => {
                          setActiveIndex(index);
                          executeRow(row, { fly });
                        }}
                      />
                    );
                  })}
                </div>
              ))}
          </div>
          {noResults && (
            <NoResults
              query={query}
              isCommandMode={isCommandMode}
              filesOnly={filesOnly}
              onSearchFilesOnly={() => setFilesOnly(true)}
            />
          )}
        </div>

        {/* Visually hidden live region: announces the result count / the
         *  no-results state to screen readers as the query changes (the
         *  listbox's own role="option"/aria-selected updates are enough for
         *  traversal, but a screen reader doesn't otherwise learn that a
         *  keystroke just changed how many results there are). */}
        <div aria-live="polite" className="sr-only">
          {statusMessage}
        </div>

        <div className="flex h-9 shrink-0 items-center gap-3 border-t border-[rgba(148,163,207,0.14)] px-3 text-[11px] opacity-55">
          <span className="hidden items-center gap-1 sm:inline-flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd> go
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>⌘↵</Kbd> reveal only
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>esc</Kbd> close
          </span>
          <span className="ml-auto shrink-0 tabular-nums">{flatRows.length}</span>
        </div>
      </div>
    </>
  );
}

function NoResults({
  query,
  isCommandMode,
  filesOnly,
  onSearchFilesOnly,
}: {
  query: string;
  isCommandMode: boolean;
  filesOnly: boolean;
  onSearchFilesOnly: () => void;
}) {
  return (
    <div className="flex flex-col items-center px-3 py-10 text-center">
      <p className="text-[13px] font-medium">
        {isCommandMode ? `No commands match "${query.slice(1).trim()}"` : `No matches for "${query}"`}
      </p>
      <p className="mt-1 max-w-xs text-[11px] opacity-70">
        {isCommandMode
          ? "Check the spelling, or clear the > prefix to search symbols and files too."
          : "Check the spelling, try fewer words, or narrow the search to files only."}
      </p>
      {!isCommandMode && !filesOnly && (
        <button
          type="button"
          onClick={onSearchFilesOnly}
          className="mt-3 rounded-[8px] border border-[rgba(148,163,207,0.2)] px-2.5 py-1 text-[11px] hover:bg-white/5"
        >
          Search files only
        </button>
      )}
    </div>
  );
}

function Row({
  rowId,
  row,
  active,
  confidenceIndex,
  onHover,
  onCommit,
}: {
  rowId: string;
  row: Row;
  active: boolean;
  confidenceIndex: Map<string, number>;
  onHover: () => void;
  onCommit: (fly: boolean) => void;
}) {
  const disabled = isRowDisabled(row);
  const base =
    "flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left transition-colors";
  const tone = disabled
    ? "cursor-not-allowed opacity-40"
    : active
      ? "bg-white/10"
      : "bg-transparent hover:bg-white/5";

  const onMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (disabled) return;
    onCommit(!(e.metaKey || e.ctrlKey));
  };

  if (row.kind === "command") {
    const subtitle = disabled ? row.cmd.disabledReason ?? row.cmd.subtitle : row.cmd.subtitle;
    return (
      <div
        id={rowId}
        role="option"
        aria-selected={active}
        aria-disabled={disabled}
        data-active={active}
        onPointerMove={disabled ? undefined : onHover}
        onMouseDown={onMouseDown}
        className={`${base} ${tone}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{row.cmd.label}</span>
          {subtitle && <span className="block truncate text-[11px] opacity-55">{subtitle}</span>}
        </span>
        {row.cmd.kbd && <Kbd>{row.cmd.kbd}</Kbd>}
      </div>
    );
  }

  const confidence = nodeConfidence(confidenceIndex, row.id);
  return (
    <div
      id={rowId}
      role="option"
      aria-selected={active}
      data-active={active}
      onPointerMove={onHover}
      onMouseDown={onMouseDown}
      className={`${base} ${tone}`}
      title={row.filePath || row.name}
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: nodeKindColorVar(row.nodeKind) }}
      />
      <span aria-hidden="true" className="w-3 shrink-0 text-center text-[12px] opacity-70">
        {nodeKindGlyph(row.nodeKind)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{row.name}</span>
        {row.filePath && (
          <span className="block truncate font-mono text-[11px] opacity-55">{row.filePath}</span>
        )}
      </span>
      {confidence < 1 && <ConfidenceBadge value={confidence} />}
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  return (
    <span
      title={`Touched by a low-confidence edge (${Math.round(value * 100)}%)`}
      className="shrink-0 rounded-full border border-[color-mix(in_srgb,var(--color-brand-amber)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-brand-amber)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-brand-amber)] tabular-nums"
    >
      {Math.round(value * 100)}%
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] border border-[rgba(148,163,207,0.18)] bg-white/5 px-1.5 font-mono text-[10px] opacity-80">
      {children}
    </kbd>
  );
}
