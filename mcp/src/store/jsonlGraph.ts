/** Parses committed RepoSkein JSONL into in-memory records + lookup indices.
 *  Pure (no I/O) so it is trivially testable. Committed JSONL has no repo_id
 *  property — the repo is implied by which repo's .reposkein/ was loaded. */

export interface ParsedNode {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
}

export interface ParsedEdge {
  from: string;
  type: string;
  to: string;
  props: Record<string, unknown>;
}

export interface ParsedGraph {
  byId: Map<string, ParsedNode>;
  /** CALLS edges only, grouped by source id. */
  callsFrom: Map<string, ParsedEdge[]>;
  /** CALLS edges only, grouped by target id. */
  callsTo: Map<string, ParsedEdge[]>;
  nodes: ParsedNode[];
  edges: ParsedEdge[];
}

function parseNodeLine(line: string): ParsedNode | null {
  const obj = JSON.parse(line) as Record<string, unknown>;
  const id = obj.id;
  const labels = obj.labels;
  if (typeof id !== "string" || !Array.isArray(labels)) return null;
  const props: Record<string, unknown> = { ...obj };
  delete props.id;
  delete props.labels;
  return { id, labels: labels.filter((l): l is string => typeof l === "string"), props };
}

function parseEdgeLine(line: string): ParsedEdge | null {
  const obj = JSON.parse(line) as Record<string, unknown>;
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

export function parseNodes(text: string): ParsedNode[] {
  const out: ParsedNode[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const n = parseNodeLine(line);
    if (n) out.push(n);
  }
  return out;
}

export function parseEdges(text: string): ParsedEdge[] {
  const out: ParsedEdge[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const e = parseEdgeLine(line);
    if (e) out.push(e);
  }
  return out;
}

/** Builds lookup indices from parsed node/edge text. */
export function buildGraph(nodesText: string, edgesText: string): ParsedGraph {
  const nodes = parseNodes(nodesText);
  const edges = parseEdges(edgesText);
  const byId = new Map<string, ParsedNode>();
  for (const n of nodes) byId.set(n.id, n);
  const callsFrom = new Map<string, ParsedEdge[]>();
  const callsTo = new Map<string, ParsedEdge[]>();
  for (const e of edges) {
    if (e.type !== "CALLS") continue;
    (callsFrom.get(e.from) ?? callsFrom.set(e.from, []).get(e.from)!).push(e);
    (callsTo.get(e.to) ?? callsTo.set(e.to, []).get(e.to)!).push(e);
  }
  return { byId, callsFrom, callsTo, nodes, edges };
}

/** An empty graph (used when .reposkein files are missing). */
export function emptyGraph(): ParsedGraph {
  return { byId: new Map(), callsFrom: new Map(), callsTo: new Map(), nodes: [], edges: [] };
}
