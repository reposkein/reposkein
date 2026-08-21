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
 *  closes on the first Esc and the tour only exits on a second one.
 *  `panels/LayerShell.tsx` reads it for the same reason. */
let open = false;

export function isCommandPaletteOpen(): boolean {
  return open;
}

export function setCommandPaletteOpen(next: boolean): void {
  open = next;
}

/** Imperative "open the palette" handle, registered by the mounted
 *  <CommandPalette/> — same rendezvous pattern as `scene/Screenshot.tsx`'s
 *  `captureFn`. Added in V3 when the standalone SearchPanel retired: the
 *  palette now owns `/` as well as ⌘K, and Root's global key handler needs a
 *  way to summon it without either lifting the palette's open state into the
 *  reducer or reaching for a DOM id (`document.getElementById("reposkein-search")`
 *  was how `/` used to focus the retired search input). No-op before mount. */
let opener: (() => void) | null = null;

export function registerPaletteOpener(fn: (() => void) | null): void {
  opener = fn;
}

/** Summons the command palette. Best-effort: no-op until it has mounted. */
export function requestCommandPalette(): void {
  opener?.();
}
