import { useEffect, useRef, type ReactNode } from "react";
import { useStoreState } from "../state/store";
import { hideLayer, type LayerId } from "./layerState";
import { isCommandPaletteOpen } from "./paletteOpenState";
import { useViewportWidth, BP_INSPECTOR_SHEET, BP_LAYER_FULL_WIDTH } from "./viewport";

/** Where a layer sits horizontally. Vertical placement is uniform (`bottom-9`,
 *  clearing the 28px status bar), so only this varies. */
export type LayerDock = "right" | "center";

/** The Inspector's width, and the gutter used around/between layers. Named here
 *  because the layer placement below has to reserve exactly that column — see
 *  `layerPlacement`. Keep in sync with `Inspector.tsx`'s `w-[360px]`. */
const INSPECTOR_W = "360px";
const GUTTER = "0.75rem"; // = right-3 / left-3

/** Horizontal placement + width clamp for a summoned layer.
 *
 *  THE BUG THIS SOLVES (fix round 1, I1): all three right-docked layers used a
 *  flat `right-3`, and the Inspector is a 360px drawer pinned to the same edge
 *  at a LOWER z-index (110 vs the layer's 120). So selecting a node and opening
 *  the legend painted the sheet straight over the Inspector's pinned Impact /
 *  Focus action row — the layer won on z-index and the actions became
 *  unreachable.
 *
 *  Fixed by reserving the drawer's column rather than by nudging pixels: when
 *  the Inspector is mounted AND rendering as a drawer, right-docked layers
 *  shift left by its full width plus a gutter, and centered ones re-center
 *  inside the remaining region. The `max-w` clamp is the other half —
 *  without it a layer wider than the remaining space (the help overlay wants
 *  30rem) would simply overflow back across the drawer.
 *
 *  `reserveInspectorColumn` — NOT a media query (fix round 2 / REP-22 fix
 *  round 1, review finding #1). This used to be an `inspectorOpen` boolean
 *  applied through Tailwind's `md:` (768px) prefix, and Inspector.tsx
 *  independently switches to a full-width bottom sheet below
 *  `BP_INSPECTOR_SHEET` (900px) — two different breakpoints deciding the SAME
 *  question ("is there a drawer to avoid?") could only agree by accident.
 *  Between 768–899px with a selection, the drawer had already become a
 *  bottom sheet (no column to avoid) while this module's `md:` class still
 *  fired, so every layer sat needlessly shifted/narrowed for a drawer that
 *  wasn't there.
 *
 *  The fix: the caller computes this flag in JS from the SAME
 *  `BP_INSPECTOR_SHEET` constant (`viewport.ts`) Inspector.tsx reads — one
 *  source of truth, no independent CSS breakpoint to drift out of sync
 *  again. Below `BP_INSPECTOR_SHEET` the Inspector is a bottom sheet (no
 *  column to reserve regardless of selection); a transient, Esc-dismissable
 *  layer sharing the screen with it there is the correct outcome, not a
 *  regression.
 *
 *  Pure and exported so the geometry is unit-testable without measuring a
 *  layout jsdom doesn't compute.
 *
 *  `fullWidthSheet` (Astrolabe V5 §2, responsive <640px): overrides dock/
 *  inspector-column reasoning entirely. Below `BP_LAYER_FULL_WIDTH` there is
 *  no room left over for ANY docked width (184px–30rem, per layer) — and the
 *  Inspector is itself a full-bleed bottom sheet down here, so there is no
 *  column to reserve either. Every layer becomes one full-width bottom sheet
 *  regardless of its normal `dock`. */
export function layerPlacement(
  dock: LayerDock,
  reserveInspectorColumn: boolean,
  fullWidthSheet = false,
): string {
  if (fullWidthSheet) return "bottom-9 inset-x-3 max-w-none";
  // Room a layer may occupy: the viewport minus its own two gutters, and minus
  // the Inspector's column when (and only when) it's actually a drawer.
  const maxW = reserveInspectorColumn
    ? `max-w-[calc(100vw-${INSPECTOR_W}-${GUTTER}*3)]`
    : `max-w-[calc(100vw-${GUTTER}*2)]`;
  const right = reserveInspectorColumn ? `right-[calc(${INSPECTOR_W}+${GUTTER})]` : "right-3";
  // `mx-auto` with BOTH insets set centers the box inside them, so a centered
  // layer automatically re-centers in whatever region is left over.
  const horizontal = dock === "center" ? `left-3 ${right} mx-auto` : right;
  return `bottom-9 ${horizontal} ${maxW}`;
}

/** Shared shell for every summoned layer (Astrolabe V3 §2). One place owns the
 *  behaviours all four layers must share, so none of them can drift:
 *
 *   - ESC STACK POSITION. A capture-phase window listener that steps aside when
 *     the palette is open (it wins) or a guided tour is running (it wins too),
 *     and otherwise closes the layer and CONSUMES the key — which is what stops
 *     the same Esc from also reaching the status bar's mode-chip dismissal or
 *     the global handler's deselect. Full order: palette > tour > layer >
 *     chip > deselect. See `panels/layerStack.test.tsx`.
 *   - OUTSIDE CLICK dismisses. A layer is summoned, not docked; clicking the
 *     scene puts it away.
 *   - PLACEMENT that never collides with the Inspector — see `layerPlacement`.
 *   - BLUR IS ALLOWED HERE and only here (V3 §6): layers are transient, so a
 *     backdrop blur costs nothing in sustained legibility. The Inspector — which
 *     can stay open for minutes — is deliberately opaque instead.
 *   - MOTION. A short rise-in, skipped under `prefers-reduced-motion`.
 *
 *  `role="dialog"` (non-modal: focus is NOT trapped — these are glanceable
 *  surfaces, and trapping focus in the minimap would be hostile) with an
 *  accessible name from `title`. */
export function LayerShell({
  id,
  title,
  dock,
  width,
  children,
}: {
  id: LayerId;
  /** Accessible name + the visible header label. */
  title: string;
  /** Which edge this layer docks to. */
  dock: LayerDock;
  /** Tailwind width class (the DESIRED width; `layerPlacement` clamps it). */
  width: string;
  children: ReactNode;
}) {
  const state = useStoreState();
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportWidth = useViewportWidth();
  // Astrolabe V5 §2: below this width EVERY layer becomes a full-width bottom
  // sheet, overriding its normal dock/width entirely (see `layerPlacement`'s
  // docstring) — so the caller's desired `width` class is dropped too; the
  // sheet placement already governs width on its own.
  const fullWidthSheet = viewportWidth < BP_LAYER_FULL_WIDTH;

  // The Inspector mounts on a live selection of a node that exists in the
  // graph, so mirror that exact condition rather than just `selected !== null`
  // — a stale deep-link id leaves `selected` set with no drawer on screen, and
  // reserving a column for a drawer that isn't there would look like a bug.
  const inspectorOpen =
    state.status.kind === "ready" &&
    state.selected !== null &&
    state.model?.records.has(state.selected) === true;

  // Reserve the drawer's column ONLY when the Inspector is actually
  // rendering as a right-docked drawer — open AND wide enough that
  // Inspector.tsx itself chose drawer mode over its <900px bottom sheet.
  // Both this module and Inspector.tsx read the SAME `BP_INSPECTOR_SHEET`
  // constant from `viewport.ts`, so the two can never independently drift
  // the way a second, hardcoded breakpoint here once did (fix round 1).
  const reserveInspectorColumn = inspectorOpen && viewportWidth >= BP_INSPECTOR_SHEET;

  // The tour flag, read from a listener that must not be re-created per
  // dispatch (same ref pattern as StatusBar's Esc handler).
  const tourRef = useRef(state.tour);
  tourRef.current = state.tour;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isCommandPaletteOpen()) return; // palette is above everything
      if (tourRef.current) return; // the tour owns Esc while active
      e.preventDefault();
      e.stopImmediatePropagation();
      hideLayer();
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (rootRef.current?.contains(target)) return;
      // The status bar's own layer pills are NOT "outside". Without this, the
      // mousedown would close the layer and the click that follows would
      // re-open it through `toggleLayer` — so clicking Legend while the legend
      // was open looked like a no-op. The pills mark themselves with
      // `data-layer-toggle` (panels/StatusBar.tsx) and own the toggling.
      if (target?.closest?.("[data-layer-toggle]")) return;
      hideLayer();
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={title}
      data-layer={id}
      data-testid={`layer-${id}`}
      data-inspector-open={inspectorOpen}
      data-reserve-inspector-column={reserveInspectorColumn}
      data-full-width-sheet={fullWidthSheet}
      className={`pointer-events-auto fixed z-[120] ${layerPlacement(dock, reserveInspectorColumn, fullWidthSheet)} ${fullWidthSheet ? "" : width} motion-safe:animate-[rs-layer-in_140ms_ease-out] overflow-hidden rounded-[10px] border border-[rgba(148,163,207,0.2)] bg-[color-mix(in_srgb,var(--color-brand-navy)_88%,white_4%)] text-[13px] text-[var(--color-brand-cream)] shadow-[0_12px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-md`}
    >
      <div className="flex h-7 items-center justify-between border-b border-[rgba(148,163,207,0.16)] px-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wider opacity-70">{title}</span>
        <button
          type="button"
          onClick={() => hideLayer()}
          aria-label={`Close ${title}`}
          className="min-h-5 min-w-5 text-[11px] opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}
