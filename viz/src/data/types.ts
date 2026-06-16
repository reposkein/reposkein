/** Shared data contract types — mirror the committed RepoSkein JSONL exactly.
 *  Parsing semantics intentionally match mcp/src/store/jsonlGraph.ts so the
 *  viewer and the engine agree on the graph.
 *
 *  Node: { id, labels[], ...props }  (props incl. name, qualified_name,
 *  file_path, path, start_line, end_line, kind via labels[0], content_hash,
 *  semantic_summary?, summary_of_hash?, role, extension, language).
 *  Edge: { from, type, to, ...props } (props incl. resolution, confidence,
 *  call_sites, sites, symbols[]). */

export interface RawNode {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
}

export interface RawEdge {
  from: string;
  type: string;
  to: string;
  props: Record<string, unknown>;
}

export interface RawGraph {
  nodes: RawNode[];
  edges: RawEdge[];
}

/** Structural edge types: they build the LOD tree and are NEVER drawn. */
export const STRUCTURAL_EDGE_TYPES = new Set(["CONTAINS", "DEFINES"]);

/** Relationship edge types: drawn as constellation lines. */
export const RELATIONSHIP_EDGE_TYPES = new Set([
  "CALLS",
  "IMPORTS",
  "INSTANTIATES",
  "IMPLEMENTS",
  "INHERITS",
]);

export type Resolution = "exact" | "name_match" | "ambiguous";

/** Confidence buckets for opacity/style encoding (§7). */
export function confidenceBucket(props: Record<string, unknown>): Resolution {
  const res = props.resolution;
  if (res === "exact" || res === "name_match" || res === "ambiguous") return res;
  // Fall back to numeric confidence when resolution is absent.
  const c = typeof props.confidence === "number" ? props.confidence : 1.0;
  if (c >= 0.95) return "exact";
  if (c >= 0.5) return "name_match";
  return "ambiguous";
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : fallback;
}
