/** Pure NDJSON parsing — mirrors mcp/src/store/jsonlGraph.ts semantics so the
 *  viewer agrees with the engine: each line is plain JSON; id+labels (nodes)
 *  and from+type+to (edges) are lifted out, everything else becomes props.
 *  Malformed / shape-invalid lines are skipped (never throw on one bad line). */

import type { RawEdge, RawGraph, RawNode } from "./types";

export function parseNodeLine(line: string): RawNode | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = obj.id;
  const labels = obj.labels;
  if (typeof id !== "string" || !Array.isArray(labels)) return null;
  const props: Record<string, unknown> = { ...obj };
  delete props.id;
  delete props.labels;
  return {
    id,
    labels: labels.filter((l): l is string => typeof l === "string"),
    props,
  };
}

export function parseEdgeLine(line: string): RawEdge | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const from = obj.from;
  const type = obj.type;
  const to = obj.to;
  if (typeof from !== "string" || typeof type !== "string" || typeof to !== "string") return null;
  const props: Record<string, unknown> = { ...obj };
  delete props.from;
  delete props.type;
  delete props.to;
  return { from, type, to, props };
}

export function parseNodes(text: string): RawNode[] {
  const out: RawNode[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const n = parseNodeLine(line);
    if (n) out.push(n);
  }
  return out;
}

export function parseEdges(text: string): RawEdge[] {
  const out: RawEdge[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const e = parseEdgeLine(line);
    if (e) out.push(e);
  }
  return out;
}

export function parseGraph(nodesText: string, edgesText: string): RawGraph {
  return { nodes: parseNodes(nodesText), edges: parseEdges(edgesText) };
}
