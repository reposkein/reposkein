/** Pure helpers for the "supernova" expand/collapse morph (render-time only —
 *  it animates the TRANSITION of the Points buffer; final positions are the
 *  deterministic layout and are never changed). */

/** Animation duration (ms) for a single expand/collapse morph. */
export const MORPH_MS = 500;

/** Ease-out cubic — children burst out fast then settle. */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 3);
}

/** Diff two expansion sets and return the keys that were newly expanded and
 *  newly collapsed. Deterministic; pure. */
export function diffExpanded(
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>
): { expanded: string[]; collapsed: string[] } {
  const expanded: string[] = [];
  const collapsed: string[] = [];
  for (const k of next) if (!prev.has(k)) expanded.push(k);
  for (const k of prev) if (!next.has(k)) collapsed.push(k);
  return { expanded, collapsed };
}
