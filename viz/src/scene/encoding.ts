/** Visual encoding (design §7): node color by kind, edge color by type,
 *  edge opacity/style by confidence/resolution, node size by degree. */

import type { ClusterKind } from "../data/cluster";

/** [r,g,b] in 0..1. */
export type RGB = [number, number, number];

const hex = (h: string): RGB => {
  const n = parseInt(h.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

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

/** Node size: base + k·log(1 + degree). Cluster cores are larger. */
export function nodeSize(clusterKind: ClusterKind, degree: number): number {
  const base =
    clusterKind === "galaxy" ? 6 : clusterKind === "dir" ? 3.5 : clusterKind === "file" ? 2.6 : 1.4;
  return base + 0.9 * Math.log(1 + degree);
}
