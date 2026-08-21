/** Ephemeral local-UI overlays owned by the status bar (the lens popover, and
 *  the narrow-width "N modes" chip-summary popover) — tiny module-level
 *  singletons mirroring `paletteOpenState.ts`'s pattern, for the exact same
 *  reason: these popovers own their OWN open/close transition as local
 *  `useState` (a store action would re-render the whole bar for what is
 *  purely local UI), but the status bar's capture-phase Esc handler
 *  (StatusBar.tsx) still needs to know "is something ABOVE me in the stack
 *  currently open" without subscribing to that local state itself.
 *
 *  Stacking rule (newest overlay wins Esc): StatusBar's mode-chip Esc handler
 *  checks these FIRST and steps aside (does nothing, lets the event keep
 *  propagating) while either popover is open — the popover's own Escape
 *  handling (bubble phase) then closes it and consumes the event. Only once
 *  both report closed does a second Esc reach the chip-dismiss logic. */

let lensPopoverOpen = false;
let chipsPopoverOpen = false;

export function isLensPopoverOpen(): boolean {
  return lensPopoverOpen;
}

export function setLensPopoverOpen(next: boolean): void {
  lensPopoverOpen = next;
}

export function isChipsPopoverOpen(): boolean {
  return chipsPopoverOpen;
}

export function setChipsPopoverOpen(next: boolean): void {
  chipsPopoverOpen = next;
}
