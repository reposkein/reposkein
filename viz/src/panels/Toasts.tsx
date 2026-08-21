import { dismissToast, useToasts, type ToastTone } from "./toastState";
import { useOpenLayer } from "./layerState";

/** Toast host (Astrolabe V3 §5). Bottom-center, just above the status bar.
 *
 *  ONE `aria-live="polite"` region wrapping the stack (not per-toast) so a
 *  screen reader announces each new message once as it mounts; the region is
 *  always present in the DOM (an aria-live region added at the same time as its
 *  content is not reliably announced). Each toast carries a manual dismiss for
 *  pointer users — auto-dismiss is the norm, not the only exit.
 *
 *  MOVES TO THE TOP while a summoned layer is open (fix round 2 / REP-22
 *  polish): the bottom-center toast stack (z-150) used to sit ABOVE a
 *  centered layer (z-120) in paint order without any positional awareness of
 *  it, so a toast firing while the Help overlay was open could paint over its
 *  bottom edge — and, since every layer becomes a full-width bottom sheet
 *  below 640px (Astrolabe V5 §2), the same collision is now possible for the
 *  right-docked layers too. Any open layer is reason enough to move: there is
 *  no bottom-docked toast position guaranteed clear of all four. */

const TONE: Record<ToastTone, string> = {
  info: "border-[rgba(148,163,207,0.28)] text-[var(--color-brand-cream)]",
  accent:
    "border-[color-mix(in_srgb,var(--color-brand-teal)_45%,transparent)] text-[var(--color-brand-teal)]",
  warn: "border-[color-mix(in_srgb,var(--color-brand-amber)_50%,transparent)] text-[var(--color-brand-amber)]",
};

export function Toasts() {
  const toasts = useToasts();
  const layerOpen = useOpenLayer() !== null;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      data-testid="toast-region"
      data-position={layerOpen ? "top" : "bottom"}
      className={`pointer-events-none fixed left-1/2 z-[150] flex w-[min(360px,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-1.5 ${
        layerOpen ? "top-3" : "bottom-10"
      }`}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          data-testid="toast"
          className={`pointer-events-auto flex w-full items-start gap-2 rounded-[8px] border bg-[color-mix(in_srgb,var(--color-brand-navy)_94%,white_6%)] px-3 py-2 text-[13px] shadow-[0_8px_24px_-10px_rgba(0,0,0,0.7)] ${TONE[t.tone]}`}
        >
          <span className="min-w-0 flex-1">
            <span className="block">{t.text}</span>
            {t.hint && (
              <span className="mt-0.5 block text-[11px] text-[var(--color-brand-cream)] opacity-70">
                {t.hint}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss notification"
            className="shrink-0 text-[var(--color-brand-cream)] opacity-70 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
