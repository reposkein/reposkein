import type { ReactNode } from "react";

/** CINEMATIC MODE (Astrolabe V3 §3): one fade group holding all the persistent
 *  chrome, so entering the guided tour fades the whole HUD at once — status bar,
 *  inspector, summoned layer, toasts.
 *
 *  This group's OWN visibility is a pure function of `hidden`, so there is
 *  nothing for it to save or restore. That is not true of everything inside it:
 *  a summoned layer is genuinely closed on tour entry (it would otherwise keep
 *  consuming Esc, which the tour needs), so `panels/layerState.ts` parks it in
 *  `stashLayer()` and `TourController` calls `restoreStashedLayer()` on exit.
 *  The round trip is real state, not a side effect of the fade.
 *
 *  The tour's caption and transport are rendered OUTSIDE this group by Root.
 *  That's the reason `TourController` no longer lives inside the status bar as
 *  it did in V2 — the caption would have faded along with the bar, which is why
 *  V2 never actually had a cinematic mode.
 *
 *  THREE LAYOUT DETAILS THAT ARE LOAD-BEARING, not styling preference:
 *
 *  1. `fixed inset-0`. The children are themselves `fixed`, and an element with
 *     `opacity < 1` becomes a containing block for fixed descendants. A wrapper
 *     smaller than the viewport would therefore SHIFT the status bar and the
 *     inspector for the duration of the transition. Matching the viewport makes
 *     the new containing block identical to the old one.
 *  2. `pointer-events-none` here, `pointer-events-auto` on each chrome surface.
 *     An invisible full-screen wrapper must never intercept clicks meant for the
 *     canvas.
 *  3. `inert` while hidden (React 19 prop → the HTML `inert` attribute). Opacity
 *     alone leaves faded chrome CLICKABLE and TAB-FOCUSABLE, and the children's
 *     own `pointer-events-auto` overrides any `pointer-events-none` set here, so
 *     the wrapper cannot switch that off on their behalf. `aria-hidden` was also
 *     wrong on its own: hiding a subtree that still contains focusable controls
 *     from the accessibility tree is an ARIA violation. `inert` removes pointer
 *     events, focusability and accessibility-tree presence in one move — so it
 *     replaces `aria-hidden` here rather than joining it. */
export function ChromeGroup({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <div
      data-testid="chrome-group"
      data-hidden={hidden}
      inert={hidden}
      className={`pointer-events-none fixed inset-0 z-[100] transition-opacity duration-500 motion-reduce:transition-none ${
        hidden ? "opacity-0" : "opacity-100"
      }`}
    >
      {children}
    </div>
  );
}
