import { useEffect, useRef, type ReactNode } from "react";
import { useStoreState } from "../state/store";
import { hideLayer, type LayerId } from "./layerState";
import { isCommandPaletteOpen } from "./paletteOpenState";

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
 *  the Inspector is mounted, right-docked layers shift left by its full width
 *  plus a gutter, and centered ones re-center inside the remaining region. The
 *  `max-w` clamp is the other half — without it a layer wider than the
 *  remaining space (the help overlay wants 30rem) would simply overflow back
 *  across the drawer.
 *
 *  Scoped to `md:` (≥768px) deliberately, which is exactly the width the brief
 *  specifies. Below it the Inspector is `max-w-[calc(100vw-1rem)]` — nearly the
 *  whole screen — so there is no column left to reserve; a transient,
 *  Esc-dismissable layer overlaying it there is the correct outcome, not a
 *  regression.
 *
 *  Pure and exported so the geometry is unit-testable without measuring a
 *  layout jsdom doesn't compute. */
export function layerPlacement(dock: LayerDock, inspectorOpen: boolean): string {
  // Room a layer may occupy: the viewport minus its own two gutters, and minus
  // the Inspector's column once that is on screen.
  const maxW = inspectorOpen
    ? `max-w-[calc(100vw-${GUTTER}*2)] md:max-w-[calc(100vw-${INSPECTOR_W}-${GUTTER}*3)]`
    : `max-w-[calc(100vw-${GUTTER}*2)]`;
  const right = inspectorOpen
    ? `right-3 md:right-[calc(${INSPECTOR_W}+${GUTTER})]`
    : "right-3";
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
 *     the same Esc from also reaching Root's collapse-level binding or the
 *     status bar's mode-chip dismissal. Full order: palette > tour > layer >
 *     chip > collapse-level. See `panels/layerStack.test.tsx`.
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

  // The Inspector mounts on a live selection of a node that exists in the
  // graph, so mirror that exact condition rather than just `selected !== null`
  // — a stale deep-link id leaves `selected` set with no drawer on screen, and
  // reserving a column for a drawer that isn't there would look like a bug.
  const inspectorOpen =
    state.status.kind === "ready" &&
    state.selected !== null &&
    state.model?.records.has(state.selected) === true;

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
      className={`pointer-events-auto fixed z-[120] ${layerPlacement(dock, inspectorOpen)} ${width} motion-safe:animate-[rs-layer-in_140ms_ease-out] overflow-hidden rounded-[10px] border border-[rgba(148,163,207,0.2)] bg-[color-mix(in_srgb,var(--color-brand-navy)_88%,white_4%)] text-[13px] text-[var(--color-brand-cream)] shadow-[0_12px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-md`}
    >
      <div className="flex h-7 items-center justify-between border-b border-[rgba(148,163,207,0.16)] px-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wider opacity-55">{title}</span>
        <button
          type="button"
          onClick={() => hideLayer()}
          aria-label={`Close ${title}`}
          className="min-h-5 min-w-5 text-[11px] opacity-55 hover:opacity-100"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}
