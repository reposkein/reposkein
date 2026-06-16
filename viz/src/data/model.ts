/** Builds the in-memory render model from a parsed graph: cluster tree +
 *  deterministic layout + relationship-edge index + per-node degree + a
 *  detail-panel record map. Pure & deterministic. */

import type { RawGraph, RawNode } from "./types";
import { RELATIONSHIP_EDGE_TYPES, confidenceBucket, num, str } from "./types";
import { buildClusterTree, type ClusterTree } from "./cluster";
import { computeLayout, type LayoutResult } from "./layout";
import { fingerprint } from "./hash";

export interface DrawEdge {
  from: string;
  to: string;
  type: string;
  resolution: "exact" | "name_match" | "ambiguous";
  confidence: number;
  /** True when source and destination come from different repos (federation). */
  crossRepo: boolean;
}

export interface NodeRecord {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  role: string;
  semanticSummary: string | null;
  summaryOfHash: string | null;
  contentHash: string | null;
  /** relationship-edge degree (excludes CONTAINS/DEFINES). */
  degree: number;
}

export interface GraphModel {
  tree: ClusterTree;
  layout: LayoutResult;
  /** Drawn relationship edges (CALLS/IMPORTS/INSTANTIATES/IMPLEMENTS/INHERITS). */
  drawEdges: DrawEdge[];
  /** Detail-panel records keyed by node id. */
  records: Map<string, NodeRecord>;
  /** relationship degree per node id. */
  degree: Map<string, number>;
  /** stable fingerprint of the graph (position-cache key). */
  fingerprint: string;
}

function recordOf(n: RawNode, degree: number): NodeRecord {
  const name = str(n.props.name) ?? "";
  return {
    id: n.id,
    name,
    qualifiedName: str(n.props.qualified_name) ?? name,
    kind: n.labels[0] ?? "",
    filePath: str(n.props.file_path) ?? str(n.props.path) ?? "",
    startLine: num(n.props.start_line),
    endLine: num(n.props.end_line),
    language: str(n.props.language) ?? "",
    role: str(n.props.role) ?? "",
    semanticSummary: str(n.props.semantic_summary),
    summaryOfHash: str(n.props.summary_of_hash),
    contentHash: str(n.props.content_hash),
    degree,
  };
}

/** Optional build inputs. `cachedPositions` is a previously-computed,
 *  fingerprint-matched position buffer that lets buildModel SKIP the force
 *  layout (purely a speed win — cached == recomputed, byte-stable). */
export interface BuildModelOptions {
  cachedPositions?: Float32Array;
}

export function buildModel(g: RawGraph, opts?: BuildModelOptions): GraphModel {
  const tree = buildClusterTree(g);
  const layout = computeLayout(tree, opts?.cachedPositions);

  // Relationship edges + degree.
  const drawEdges: DrawEdge[] = [];
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const e of g.edges) {
    if (!RELATIONSHIP_EDGE_TYPES.has(e.type)) continue;
    // Detect cross-repo edges: `rs1:<repoId>:<rest>` — compare segment [1].
    const fromParts = e.from.split(":");
    const toParts = e.to.split(":");
    const crossRepo =
      fromParts[0] === "rs1" &&
      toParts[0] === "rs1" &&
      fromParts[1] !== toParts[1];
    drawEdges.push({
      from: e.from,
      to: e.to,
      type: e.type,
      resolution: confidenceBucket(e.props),
      confidence: num(e.props.confidence, 1.0),
      crossRepo,
    });
    bump(e.from);
    bump(e.to);
  }

  const records = new Map<string, NodeRecord>();
  for (const n of g.nodes) {
    records.set(n.id, recordOf(n, degree.get(n.id) ?? 0));
  }

  // Fingerprint from content hashes in JSONL (already-sorted) order.
  const parts: string[] = [];
  for (const n of g.nodes) parts.push(n.id, str(n.props.content_hash) ?? "");
  const fp = fingerprint(parts);

  return { tree, layout, drawEdges, records, degree, fingerprint: fp };
}
