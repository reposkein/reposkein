/** Whether the ⌘K command palette is currently open — a tiny module-level
 *  singleton (mirrors `scene/Controls.tsx`'s `cameraTarget`/`getCameraTarget`
 *  and `scene/Screenshot.tsx`'s `captureFn` pattern) so a sibling HUD
 *  component can check it WITHOUT lifting the palette's open/close
 *  transition into the reducer. That matters here specifically: every
 *  `useStore()`/`useStoreState()` consumer re-renders on any reducer
 *  transition, and the palette's whole perf contract is that opening/closing
 *  it stays cheap — a store action would re-render every panel on every
 *  ⌘K press.
 *
 *  Stacking rule: the newest overlay wins Esc. `TourController`'s
 *  capture-phase Esc handler reads this and steps aside (does nothing, lets
 *  the event keep propagating) while the palette is open, so the palette
 *  closes on the first Esc and the tour only exits on a second one. */
let open = false;

export function isCommandPaletteOpen(): boolean {
  return open;
}

export function setCommandPaletteOpen(next: boolean): void {
  open = next;
}
