/** THE URL AS A VIEW (Astrolabe V4 §7).
 *
 *  V3's deep link carried one thing: `?node=<id>`. Everything else about what
 *  the reader was looking at — which lens narrowed the graph, which overlays
 *  were painted over it — was invisible to the link. So "look at this" shared a
 *  node and threw away the reason it mattered: the recipient opened the same
 *  star with no impact overlay, no focus neighbourhood, the default lens, and no
 *  way to tell anything was missing.
 *
 *  This module is the whole encoding, as pure functions over plain records. It
 *  lives in `data/` and imports no router and no React for the usual reason:
 *  `routes/Root.tsx` mounts the <Canvas>, so anything asserted there needs a
 *  WebGL harness. Root keeps only the two effects; every rule about what a URL
 *  means is here and unit-tested.
 *
 *  HASH-HISTORY SAFE. The static export (`view --export`) is hosted at an
 *  unknown subpath and therefore uses hash history (see `main.tsx`), so these
 *  params live after a `#` as often as not. Two consequences the encoding
 *  respects:
 *
 *   - No `+` in any token. In a query string `+` decodes to a space, and
 *     `audit=ambiguous+name` came back as `ambiguous name`. The wire form is
 *     `ambiguous-name`.
 *   - Params are omitted, never emitted empty, when they hold the default. A
 *     default-valued param is noise in a shared link, and `?lens=all&overlays=`
 *     invites the reader to think something is on. */

import { LENS_ORDER, type LensId } from "./lens";
import type { AuditMode } from "../state/store";
import { clampDepth, DEFAULT_FOCUS_DEPTH } from "./neighborhood";

/** The search params, as the router stores them: strings or absent. */
export interface ViewSearch {
  node?: string;
  lens?: string;
  overlays?: string;
}

/** The overlays a link can carry. Deliberately a flat record rather than the
 *  store's own overlay values: `impact` and `focus` hold COMPUTED results
 *  (transitive caller sets, BFS neighbourhoods) that no URL should try to
 *  serialise — the link records that the overlay was ON, and the app recomputes
 *  it against the graph the recipient actually has. */
export interface ViewOverlays {
  impact: boolean;
  /** Focus depth when the focus overlay was active, else null. */
  focus: number | null;
  coupling: boolean;
  /** null = audit off. */
  audit: AuditMode | null;
}

export interface ParsedView {
  node: string | null;
  /** null when absent or unrecognised — the caller keeps its current lens. */
  lens: LensId | null;
  overlays: ViewOverlays;
}

export const NO_OVERLAYS: ViewOverlays = {
  impact: false,
  focus: null,
  coupling: false,
  audit: null,
};

/** Wire spelling for the two audit modes. `ambiguous+name` would arrive as
 *  `ambiguous name` after query-string decoding — see the module docstring. */
const AUDIT_TO_WIRE: Record<Exclude<AuditMode, "off">, string> = {
  ambiguous: "ambiguous",
  "ambiguous+name": "ambiguous-name",
};
const WIRE_TO_AUDIT: Record<string, AuditMode> = {
  ambiguous: "ambiguous",
  "ambiguous-name": "ambiguous+name",
};

const LENS_IDS = new Set<string>(LENS_ORDER);

/** The slice of state a link describes. Narrow on purpose, so a caller can
 *  build one from a test literal. */
export interface LinkableView {
  selected: string | null;
  lens: LensId;
  impact: unknown | null;
  focus: unknown | null;
  focusDepth: number;
  coupling: boolean;
  audit: AuditMode;
}

/** State → search params, omitting everything at its default. Pure. */
export function encodeViewSearch(view: LinkableView): ViewSearch {
  const out: ViewSearch = {};
  if (view.selected) out.node = view.selected;
  if (view.lens !== "all") out.lens = view.lens;

  const overlays: string[] = [];
  if (view.impact) overlays.push("impact");
  if (view.focus) overlays.push(`focus:${clampDepth(view.focusDepth)}`);
  if (view.coupling) overlays.push("coupling");
  if (view.audit !== "off") overlays.push(`audit:${AUDIT_TO_WIRE[view.audit]}`);
  if (overlays.length > 0) out.overlays = overlays.join(",");

  return out;
}

/** Search params → a description of the view, tolerating anything.
 *
 *  A shared link is untrusted input that may also be OLD: a lens that has been
 *  renamed, an overlay this build no longer has, a depth outside the range. Every
 *  unknown token is dropped rather than treated as an error — the recipient gets
 *  as much of the view as still exists, which beats a blank screen or a notice
 *  about a param they did not type. Pure. */
export function parseViewSearch(search: ViewSearch): ParsedView {
  const node = typeof search.node === "string" && search.node.length > 0 ? search.node : null;

  const rawLens = typeof search.lens === "string" ? search.lens : "";
  const lens = LENS_IDS.has(rawLens) ? (rawLens as LensId) : null;

  const overlays: ViewOverlays = { ...NO_OVERLAYS };
  const raw = typeof search.overlays === "string" ? search.overlays : "";
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (t === "") continue;
    if (t === "impact") {
      overlays.impact = true;
      continue;
    }
    if (t === "coupling") {
      overlays.coupling = true;
      continue;
    }
    if (t === "focus") {
      // Depth-less form: accept it at the app default rather than dropping the
      // overlay a hand-edited link clearly asked for.
      overlays.focus = DEFAULT_FOCUS_DEPTH;
      continue;
    }
    if (t.startsWith("focus:")) {
      const depth = Number.parseInt(t.slice("focus:".length), 10);
      // `clampDepth` is Math.round-based and propagates NaN, so a garbage depth
      // has to fall back explicitly rather than through the clamp.
      overlays.focus = Number.isFinite(depth) ? clampDepth(depth) : DEFAULT_FOCUS_DEPTH;
      continue;
    }
    if (t.startsWith("audit:")) {
      const mode = WIRE_TO_AUDIT[t.slice("audit:".length)];
      if (mode) overlays.audit = mode;
      continue;
    }
    // Anything else: an overlay from a newer or older build. Ignored.
  }

  return { node, lens, overlays };
}

/** Router `validateSearch`: keep the three params we own, as strings, and drop
 *  everything else. Deliberately NOT `parseViewSearch` — the router's job is to
 *  normalise the shape, and interpreting the values is the app's. Pure. */
export function validateViewSearch(search: Record<string, unknown>): ViewSearch {
  const out: ViewSearch = {};
  if (typeof search.node === "string") out.node = search.node;
  if (typeof search.lens === "string") out.lens = search.lens;
  if (typeof search.overlays === "string") out.overlays = search.overlays;
  return out;
}

/** Structural equality, so the URL-sync effect can skip a `navigate()` that
 *  would change nothing. Without it, every reducer transition pushes an
 *  identical history entry. Pure. */
export function sameViewSearch(a: ViewSearch, b: ViewSearch): boolean {
  return a.node === b.node && a.lens === b.lens && a.overlays === b.overlays;
}

/** True when the parsed view asks for nothing beyond the defaults — i.e. there
 *  is no restore work to do. Pure. */
export function isDefaultView(v: ParsedView): boolean {
  return (
    v.node === null &&
    v.lens === null &&
    !v.overlays.impact &&
    v.overlays.focus === null &&
    !v.overlays.coupling &&
    v.overlays.audit === null
  );
}
