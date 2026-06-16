/** Lenses — one-click view presets that reconfigure the EXISTING filter state
 *  (hidden kinds / hidden edge types / minConfidence) plus an optional
 *  `emphasis` flag the scene reads to highlight a node class. Pure &
 *  deterministic: a lens id maps to a concrete filter snapshot.
 *
 *  IMPORTANT: filters store HIDDEN sets (a kind/type is hidden when present;
 *  empty = show everything). So "show only CALLS" hides every OTHER edge type.
 */

export type LensId = "all" | "calls" | "types" | "imports" | "tests";

/** Optional scene-emphasis driven by the active lens (read by StarField). */
export type Emphasis = "none" | "types" | "tests";

export interface LensPreset {
  id: LensId;
  label: string;
  /** short hint shown on hover. */
  hint: string;
  /** Hidden symbol kinds (lowercase, matching the existing kind filter). */
  kinds: string[];
  /** Hidden edge types. */
  edgeTypes: string[];
  /** Minimum confidence floor for edges. */
  minConfidence: number;
  emphasis: Emphasis;
}

/** All relationship edge types (must mirror RELATIONSHIP_EDGE_TYPES). */
export const ALL_EDGE_TYPES = ["CALLS", "IMPORTS", "INHERITS", "IMPLEMENTS", "INSTANTIATES"];

/** Edge types that build a type hierarchy. */
const TYPE_EDGE_TYPES = ["INHERITS", "IMPLEMENTS", "INSTANTIATES"];

/** Returns the edge types to HIDE so that only `keep` remain visible. */
function hideAllExcept(keep: string[]): string[] {
  const keepSet = new Set(keep);
  return ALL_EDGE_TYPES.filter((t) => !keepSet.has(t));
}

/** The lens preset table (single source of truth). */
export const LENS_PRESETS: Record<LensId, LensPreset> = {
  all: {
    id: "all",
    label: "All",
    hint: "Show everything (default)",
    kinds: [],
    edgeTypes: [],
    minConfidence: 0,
    emphasis: "none",
  },
  calls: {
    id: "calls",
    label: "Call graph",
    hint: "Only CALLS edges",
    kinds: [],
    edgeTypes: hideAllExcept(["CALLS"]),
    minConfidence: 0,
    emphasis: "none",
  },
  types: {
    id: "types",
    label: "Type hierarchy",
    hint: "Only INHERITS / IMPLEMENTS / INSTANTIATES; emphasize Class / Interface / Enum",
    kinds: [],
    edgeTypes: hideAllExcept(TYPE_EDGE_TYPES),
    minConfidence: 0,
    emphasis: "types",
  },
  imports: {
    id: "imports",
    label: "Imports",
    hint: "Only IMPORTS edges",
    kinds: [],
    edgeTypes: hideAllExcept(["IMPORTS"]),
    minConfidence: 0,
    emphasis: "none",
  },
  tests: {
    id: "tests",
    label: "Tests ↔ code",
    hint: "Highlight test nodes and the edges between tests and non-tests",
    kinds: [],
    edgeTypes: [],
    minConfidence: 0,
    emphasis: "tests",
  },
};

export const LENS_ORDER: LensId[] = ["all", "calls", "types", "imports", "tests"];

/** Symbol kinds (lowercase) emphasized by the "types" lens. */
export const TYPE_EMPHASIS_KINDS = new Set(["class", "interface", "enum"]);

export interface LensFilterState {
  kinds: Set<string>;
  edgeTypes: Set<string>;
  minConfidence: number;
  emphasis: Emphasis;
}

/** Resolve a lens id to a concrete filter snapshot. Pure. */
export function resolveLens(id: LensId): LensFilterState {
  const p = LENS_PRESETS[id];
  return {
    kinds: new Set(p.kinds),
    edgeTypes: new Set(p.edgeTypes),
    minConfidence: p.minConfidence,
    emphasis: p.emphasis,
  };
}
