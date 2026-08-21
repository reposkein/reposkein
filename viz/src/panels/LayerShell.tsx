import { useEffect, useRef, type ReactNode } from "react";
import { useStoreState } from "../state/store";
import { hideLayer, type LayerId } from "./layerState";
import { isCommandPaletteOpen } from "./paletteOpenState";

/** Shared shell for every summoned layer (Astrolabe V3 §2). One place owns the
 *  four behaviours all four layers must share, so none of them can drift:
 *
 *   - ESC STACK POSITION. A capture-phase window listener that steps aside when
 *     the palette is open (it wins) or a guided tour is running (it wins too),
 *     and otherwise closes the layer and CONSUMES the key — which is what stops
 *     the same Esc from also reaching Root's collapse-level binding or the
 *     status bar's mode-chip dismissal. Full order: palette > tour > layer >
 *     chip > collapse-level. See `panels/escStack.test.tsx`.
 *   - OUTSIDE CLICK dismisses. A layer is summoned, not docked; clicking the
 *     scene puts it away.
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
  placement,
  width,
  children,
}: {
  id: LayerId;
  /** Accessible name + the visible header label. */
  title: string;
  /** Tailwind placement classes (each layer docks somewhere different). */
  placement: string;
  /** Tailwind width class. */
  width: string;
  children: ReactNode;
}) {
  const state = useStoreState();
  const rootRef = useRef<HTMLDivElement>(null);

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
      className={`pointer-events-auto fixed z-[120] ${placement} ${width} motion-safe:animate-[rs-layer-in_140ms_ease-out] overflow-hidden rounded-[10px] border border-[rgba(148,163,207,0.2)] bg-[color-mix(in_srgb,var(--color-brand-navy)_88%,white_4%)] text-[13px] text-[var(--color-brand-cream)] shadow-[0_12px_36px_-12px_rgba(0,0,0,0.7)] backdrop-blur-md`}
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
