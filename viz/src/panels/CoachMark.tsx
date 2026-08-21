import { useEffect, useState } from "react";
import { dismissCoachMark, isCoachMarkDismissed } from "./coachMarkState";
import { useOpenLayer } from "./layerState";
import { useToasts } from "./toastState";

/** First-run coach mark (Astrolabe V5 §1). A SINGLE dismissible hint — not a
 *  multi-step onboarding tour (the brief is explicit about that boundary) —
 *  pointing a first-time viewer at the two entry points that unlock
 *  everything else: ⌘K for search/navigation/commands, `?` for the full
 *  keymap (including the touch equivalents, for a viewer on a tablet/phone).
 *
 *  Shows ONCE per browser: dismissal persists via `localStorage`
 *  (`coachMarkState.ts`), read on mount, so a returning viewer — or the same
 *  viewer on a later visit — never sees it again. Small and out of the way:
 *  bottom-center, just above the status bar, the same visual weight as a
 *  toast rather than a modal that blocks the scene.
 *
 *  Mounted by Root only once the graph is `ready` (there is nothing to
 *  navigate to before then), and hides itself — without dismissing — while a
 *  summoned layer OR a toast is on screen (fix round 1: bottom-9 z-101 vs.
 *  Toasts' bottom-10 z-150 sit close enough to genuinely overlap), so it can
 *  never paint under the Help overlay or a toast it is itself pointing a
 *  viewer toward. */
export function CoachMark() {
  const [visible, setVisible] = useState(false);
  const layerOpen = useOpenLayer() !== null;
  const toastVisible = useToasts().length > 0;

  useEffect(() => {
    if (!isCoachMarkDismissed()) setVisible(true);
  }, []);

  if (!visible || layerOpen || toastVisible) return null;

  function dismiss() {
    dismissCoachMark();
    setVisible(false);
  }

  return (
    <div
      role="status"
      data-testid="coach-mark"
      className="pointer-events-auto fixed inset-x-0 bottom-9 z-[101] mx-auto flex w-fit items-center gap-2 rounded-full border border-[rgba(148,163,207,0.22)] bg-[color-mix(in_srgb,var(--color-brand-navy)_92%,white_4%)] px-3 py-1.5 text-[12px] text-[var(--color-brand-cream)] shadow-[0_8px_24px_-10px_rgba(0,0,0,0.6)] motion-safe:animate-[rs-layer-in_180ms_ease-out] motion-reduce:animate-none"
    >
      <span className="flex items-center gap-1.5 opacity-90">
        <Kbd>⌘K</Kbd> to navigate <span aria-hidden="true" className="opacity-50">·</span>{" "}
        <Kbd>?</Kbd> for keys
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss hint"
        className="shrink-0 opacity-70 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-[rgba(148,163,207,0.22)] bg-white/5 px-1.5 font-mono text-[11px] opacity-90">
      {children}
    </kbd>
  );
}
