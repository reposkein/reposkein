/** Parses committed RepoSkein JSONL into in-memory records + lookup indices.
 *  Pure (no I/O) so it is trivially testable. Committed JSONL has no repo_id
 *  property — the repo is supplied by the caller (which .reposkein/ was loaded). */

export interface ParsedNode {
  id: string;
  repoId: string;
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

function parseNodeLine(line: string, repoId: string): ParsedNode | null {
  const obj = JSON.parse(line) as Record<string, unknown>;
  const id = obj.id;
  const labels = obj.labels;
  if (typeof id !== "string" || !Array.isArray(labels)) return null;
  const props: Record<string, unknown> = { ...obj };
  delete props.id;
  delete props.labels;
  return { id, repoId, labels: labels.filter((l): l is string => typeof l === "string"), props };
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

export function parseNodes(text: string, repoId: string): ParsedNode[] {
  const out: ParsedNode[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const n = parseNodeLine(line, repoId);
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
export function buildGraph(nodesText: string, edgesText: string, repoId: string): ParsedGraph {
  const nodes = parseNodes(nodesText, repoId);
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

export interface RepoSource {
  repoId: string;
  nodesText: string;
  edgesText: string;
}

const isFunction = (n: ParsedNode): boolean => n.labels.includes("Function");

/** Builds one merged graph from several repos' committed JSONL, then injects
 *  DB-only-style cross-repo CALLS edges from each caller's `external_calls`
 *  (XR-M1) to the UNIQUE function of that name in a different repo (the
 *  in-memory mirror of Neo4j's stitch_cross_repo_calls — ambiguous skipped). */
export function buildFederatedGraph(repos: RepoSource[]): ParsedGraph {
  const byId = new Map<string, ParsedNode>();
  const callsFrom = new Map<string, ParsedEdge[]>();
  const callsTo = new Map<string, ParsedEdge[]>();
  const nodes: ParsedNode[] = [];
  const edges: ParsedEdge[] = [];
  const pushCall = (e: ParsedEdge) => {
    (callsFrom.get(e.from) ?? callsFrom.set(e.from, []).get(e.from)!).push(e);
    (callsTo.get(e.to) ?? callsTo.set(e.to, []).get(e.to)!).push(e);
  };

  // 1) Parse + merge every repo.
  for (const r of repos) {
    const g = buildGraph(r.nodesText, r.edgesText, r.repoId);
    for (const n of g.nodes) {
      if (!byId.has(n.id)) {
        byId.set(n.id, n);
        nodes.push(n);
      }
    }
    for (const e of g.edges) edges.push(e);
    for (const [, list] of g.callsFrom) for (const e of list) pushCall(e);
  }

  // 2) Cross-repo name index: function name -> [{id, repoId}] (sorted by id).
  const byName = new Map<string, { id: string; repoId: string }[]>();
  for (const n of nodes) {
    if (!isFunction(n)) continue;
    const nm = typeof n.props.name === "string" ? n.props.name : null;
    if (!nm) continue;
    (byName.get(nm) ?? byName.set(nm, []).get(nm)!).push({ id: n.id, repoId: n.repoId });
  }
  for (const arr of byName.values()) arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // M3: cross-repo IMPORTS edges (File -> child File) from external_import_targets,
  // for backend parity with Neo4j's stitch_cross_repo_imports. Added to `edges`
  // (no dedicated reader yet — the committed property already carries the data).
  for (const n of nodes) {
    const targets = n.props.external_import_targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (typeof t === "string" && byId.has(t)) {
        edges.push({ from: n.id, type: "IMPORTS", to: t, props: { cross_repo: true, stitched: true } });
      }
    }
  }

  // 3) Inject cross-repo CALLS from external_calls (unique cross-repo match).
  for (const n of nodes) {
    const ext = n.props.external_calls;
    if (!Array.isArray(ext)) continue;
    const names = [...new Set(ext.filter((x): x is string => typeof x === "string"))].sort();
    for (const name of names) {
      const matches = (byName.get(name) ?? []).filter((m) => m.repoId !== n.repoId);
      if (matches.length !== 1) continue; // skip ambiguous / external
      pushCall({
        from: n.id,
        type: "CALLS",
        to: matches[0]!.id,
        props: { resolution: "name_match", confidence: 0.5, cross_repo: true, stitched: true, call_sites: 1 },
      });
    }
  }

  return { byId, callsFrom, callsTo, nodes, edges };
}
