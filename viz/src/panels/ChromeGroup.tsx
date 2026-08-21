import type { ReactNode } from "react";

/** CINEMATIC MODE (Astrolabe V3 §3): one fade group holding all the persistent
 *  chrome, so entering the guided tour fades the whole HUD at once — status bar,
 *  inspector, summoned layer, toasts — and exiting restores exactly what was
 *  visible before. "Restores" is free here because visibility is a pure function
 *  of `store.tour`; nothing is saved and nothing can be forgotten.
 *
 *  The tour's caption and transport are rendered OUTSIDE this group by Root.
 *  That's the reason `TourController` no longer lives inside the status bar as
 *  it did in V2 — the caption would have faded along with the bar, which is why
 *  V2 never actually had a cinematic mode.
 *
 *  TWO LAYOUT DETAILS THAT ARE LOAD-BEARING, not styling preference:
 *
 *  1. `fixed inset-0`. The children are themselves `fixed`, and an element with
 *     `opacity < 1` becomes a containing block for fixed descendants. A wrapper
 *     smaller than the viewport would therefore SHIFT the status bar and the
 *     inspector for the duration of the transition. Matching the viewport makes
 *     the new containing block identical to the old one.
 *  2. `pointer-events-none` here, `pointer-events-auto` on each chrome surface.
 *     An invisible full-screen wrapper must never intercept clicks meant for the
 *     canvas — and faded chrome must not be clickable during the tour either. */
export function ChromeGroup({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <div
      data-testid="chrome-group"
      data-hidden={hidden}
      aria-hidden={hidden}
      className={`pointer-events-none fixed inset-0 z-[100] transition-opacity duration-500 motion-reduce:transition-none ${
        hidden ? "opacity-0" : "opacity-100"
      }`}
    >
      {children}
    </div>
  );
}
