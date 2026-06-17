/** Visual encoding (design §7): node color by kind, edge color by type,
 *  edge opacity/style by confidence/resolution, node size by degree. */

import type { ClusterKind } from "../data/cluster";

/** [r,g,b] in 0..1. */
export type RGB = [number, number, number];

export const hex = (h: string): RGB => {
  const n = parseInt(h.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** RepoSkein brand palette — the single source of truth for accent colors used
 *  by selection / hover / impact highlights and UI chrome. These are ACCENTS:
 *  the per-node-kind and per-edge-type hues below stay distinct and legible;
 *  the brand colors only harmonize the chrome and call out the focused element.
 *
 *  amber  — primary accent: selection, the "frame all" / active chrome.
 *  teal   — secondary accent: hover highlight, covering tests, links.
 *  cream  — neutral light text / faint UI lines.
 *  navy   — the deep background (already ~the scene bg + fog color). */
export const BRAND = {
  amber: "#F2B84B",
  teal: "#2DD4BF",
  cream: "#EAE7DC",
  navy: "#070A12",
} as const;

/** Pre-parsed brand RGB triples for the GPU buffers (avoid re-parsing hex per
 *  frame / per node). */
export const BRAND_RGB = {
  amber: hex(BRAND.amber),
  teal: hex(BRAND.teal),
  cream: hex(BRAND.cream),
  navy: hex(BRAND.navy),
} as const;

/** Node color by graph label/kind, with cluster-level fallbacks. */
export function nodeColor(clusterKind: ClusterKind, symbolKind?: string): RGB {
  if (clusterKind === "galaxy") return hex("#ffffff");
  if (clusterKind === "dir") return hex("#9aa7c7");
  if (clusterKind === "file") return hex("#6ea8ff");
  switch (symbolKind) {
    case "Function":
      return hex("#ffe08a"); // warm yellow-white
    case "Class":
      return hex("#5fe0e0"); // cyan
    case "Interface":
      return hex("#b98aff"); // violet
    case "Enum":
      return hex("#7ce08a"); // green
    case "Variable":
      return hex("#9aa0a8"); // dim grey
    default:
      return hex("#cfd6e4");
  }
}

/** Per-language hue map — the SINGLE SOURCE OF TRUTH for language coloring.
 *  Each known programming language gets a distinct, legible hue used to tint
 *  cluster nebula halos so multi-language repos read as language regions. Keys
 *  are the normalized language names emitted by the engine (lower-case). An
 *  unknown language falls back to LANGUAGE_DEFAULT (a neutral slate). */
export const LANGUAGE_HEX: Record<string, string> = {
  rust: "#ff7a45",       // ember orange
  python: "#4b8bff",     // python blue
  typescript: "#3aa0ff", // TS azure
  javascript: "#f4d03f", // JS yellow
  go: "#39c5cf",         // gopher cyan
  java: "#e76f51",       // terracotta
  csharp: "#9b6dff",     // .NET violet
};
export const LANGUAGE_DEFAULT_HEX = "#8a93a8"; // neutral slate for unknowns

/** Human labels for the legend (only those actually present are shown). */
export const LANGUAGE_LABEL: Record<string, string> = {
  rust: "Rust",
  python: "Python",
  typescript: "TypeScript",
  javascript: "JavaScript",
  go: "Go",
  java: "Java",
  csharp: "C#",
};

/** Hex (string) hue for a normalized language name, with the neutral fallback. */
export function languageHex(language: string): string {
  return LANGUAGE_HEX[language] ?? LANGUAGE_DEFAULT_HEX;
}

/** Pre-parsed RGB hue for a language (for the GPU halo buffer). */
export function languageColor(language: string): RGB {
  return hex(languageHex(language));
}

const EDGE_HUE: Record<string, RGB> = {
  CALLS: hex("#ffd166"),
  IMPORTS: hex("#6ea8ff"),
  INSTANTIATES: hex("#ef8aff"),
  IMPLEMENTS: hex("#5fe0e0"),
  INHERITS: hex("#7ce08a"),
};

export function edgeColor(type: string): RGB {
  return EDGE_HUE[type] ?? hex("#8892a6");
}

/** Opacity by resolution/confidence: exact bright, name_match dimmer,
 *  ambiguous faint — but with a minimum floor (~0.15) so a rolled-up
 *  connection is ALWAYS visible (design: "connections always visible"). */
export const EDGE_OPACITY_FLOOR = 0.15;

export function edgeOpacity(resolution: "exact" | "name_match" | "ambiguous"): number {
  switch (resolution) {
    case "exact":
      return 0.75;
    case "name_match":
      return 0.42;
    case "ambiguous":
      return EDGE_OPACITY_FLOOR;
  }
}

/** Bundle opacity: scale by member count (log) so heavily-trafficked
 *  connections read brighter, then clamp to the visible floor. */
export function bundleOpacity(
  resolution: "exact" | "name_match" | "ambiguous",
  count: number
): number {
  const base = edgeOpacity(resolution);
  const boosted = base * (1 + 0.18 * Math.log(1 + count));
  return Math.min(1, Math.max(EDGE_OPACITY_FLOOR, boosted));
}

/** Adaptive global edge-opacity scale (design §1.4). Keeps total additive ink
 *  ~constant: under the budget every bundle renders at full alpha; above it,
 *  alpha scales ~1/drawn so a dense hub core dims instead of saturating white.
 *
 *  EDGE_K_MIN is the floor. With the MAX_BUNDLES≈2500 cap, drawn·EDGE_K_MIN at
 *  the cap is bounded (2500·0.04 = 100 units of un-attenuated ink ≈ the budget),
 *  so the cap and the floor together cannot blow past a sane ink ceiling. */
export const EDGE_INK_BUDGET = 220;
export const EDGE_K_MIN = 0.04;
export function adaptiveEdgeScale(drawn: number): number {
  if (drawn <= EDGE_INK_BUDGET) return 1;
  return Math.max(EDGE_K_MIN, EDGE_INK_BUDGET / drawn);
}

/** Node emissive floor (design §2): a dimmed star never reaches pure black, so
 *  it stays a faint point of light rather than vanishing under the web. Scales
 *  the triple up uniformly (preserving hue) when its brightest channel is below
 *  the floor. */
export const NODE_EMISSIVE_FLOOR = 0.1;
export function applyNodeFloor(r: number, g: number, b: number): [number, number, number] {
  const m = Math.max(r, g, b);
  if (m > 0 && m < NODE_EMISSIVE_FLOOR) {
    const s = NODE_EMISSIVE_FLOOR / m;
    return [r * s, g * s, b * s];
  }
  return [r, g, b];
}

/** Node size: base + k·log(1 + degree). Cluster cores are larger.
 *  Clamped to [NODE_SIZE_MIN, NODE_SIZE_MAX] so hubs stand out but
 *  nothing is enormous. */
export const NODE_SIZE_MIN = 1.0;
export const NODE_SIZE_MAX = 12.0;

export function nodeSize(clusterKind: ClusterKind, degree: number): number {
  const base =
    clusterKind === "galaxy" ? 6 : clusterKind === "dir" ? 3.5 : clusterKind === "file" ? 2.6 : 1.4;
  const raw = base + 0.9 * Math.log(1 + degree);
  return Math.min(NODE_SIZE_MAX, Math.max(NODE_SIZE_MIN, raw));
}

/** Metadata tables for the Legend panel (single source of truth). */
export const EDGE_TYPE_META: { type: string; color: string; label: string }[] = [
  { type: "CALLS",        color: "#ffd166", label: "Calls" },
  { type: "IMPORTS",      color: "#6ea8ff", label: "Imports" },
  { type: "INSTANTIATES", color: "#ef8aff", label: "Instantiates" },
  { type: "IMPLEMENTS",   color: "#5fe0e0", label: "Implements" },
  { type: "INHERITS",     color: "#7ce08a", label: "Inherits" },
];

export const NODE_KIND_META: { kind: string; color: string; label: string }[] = [
  { kind: "galaxy",    color: "#ffffff", label: "Repo" },
  { kind: "dir",       color: "#9aa7c7", label: "Directory" },
  { kind: "file",      color: "#6ea8ff", label: "File" },
  { kind: "Function",  color: "#ffe08a", label: "Function" },
  { kind: "Class",     color: "#5fe0e0", label: "Class" },
  { kind: "Interface", color: "#b98aff", label: "Interface" },
  { kind: "Enum",      color: "#7ce08a", label: "Enum" },
  { kind: "Variable",  color: "#9aa0a8", label: "Variable" },
];
