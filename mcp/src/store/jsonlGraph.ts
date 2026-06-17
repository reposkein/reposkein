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
 *  DB-only-style cross-repo edges (M3 + M4):
 *  - IMPORTS edges (File→File) from external_import_targets (parity with Neo4j
 *    stitch_cross_repo_imports).
 *  - CALLS edges (Function→Function) from external_calls, import-scoped first
 *    (confidence 0.6) with federation-wide unique fallback (0.5); ambiguous
 *    skipped. Per-name (mirrors Neo4j stitch_cross_repo_calls). */
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

  // 2) Cross-repo name index: function name -> [{id, repoId, fileId}] (sorted by id).
  const byName = new Map<string, { id: string; repoId: string; fileId: string }[]>();
  for (const n of nodes) {
    if (!isFunction(n)) continue;
    const nm = typeof n.props.name === "string" ? n.props.name : null;
    if (!nm) continue;
    const fp = typeof n.props.file_path === "string" ? n.props.file_path : "";
    const fileId = `rs1:${n.repoId}:file:${fp}`;
    (byName.get(nm) ?? byName.set(nm, []).get(nm)!).push({ id: n.id, repoId: n.repoId, fileId });
  }
  for (const arr of byName.values()) arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // File id -> set of external_import_targets (the child Files it imports from).
  const importTargets = new Map<string, Set<string>>();
  for (const n of nodes) {
    const t = n.props.external_import_targets;
    if (Array.isArray(t)) {
      importTargets.set(n.id, new Set(t.filter((x): x is string => typeof x === "string")));
    }
  }

  // M3: cross-repo IMPORTS edges (File -> child File) from external_import_targets,
  // for backend parity with Neo4j's stitch_cross_repo_imports. Added to `edges`.
  //
  // Read-tool scope (intentional parity): these stitched cross-repo IMPORTS — and
  // the INHERITS/IMPLEMENTS heritage edges injected in step 4 below — are computed
  // into the merged graph but are NOT walked by any read tool's traversal. impact /
  // get_context_profile neighborhoods are CALLS-only (see profile/impact.ts), so
  // the only consumers of these edges today are read_cypher and the visualization
  // exporter. This deliberately mirrors the Neo4j tool surface: that backend also
  // stitches these edges (stitch_cross_repo_imports / stitch_cross_repo_heritage)
  // without exposing a dedicated traversal reader. The edges exist for
  // read_cypher / visualization + future traversal, and both backends agree.
  for (const n of nodes) {
    const targets = n.props.external_import_targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (typeof t === "string" && byId.has(t)) {
        edges.push({ from: n.id, type: "IMPORTS", to: t, props: { cross_repo: true, stitched: true } });
      }
    }
  }

  // 3) Inject cross-repo CALLS. Prefer an import-scoped match (the called name
  //    in a file the caller's file imports from — precise); fall back to a
  //    federation-wide unique match. Per name; ambiguous skipped.
  for (const n of nodes) {
    const ext = n.props.external_calls;
    if (!Array.isArray(ext)) continue;
    const callerFp = typeof n.props.file_path === "string" ? n.props.file_path : "";
    const callerFileId = `rs1:${n.repoId}:file:${callerFp}`;
    const targets = importTargets.get(callerFileId);
    const names = [...new Set(ext.filter((x): x is string => typeof x === "string"))].sort();
    for (const name of names) {
      const all = (byName.get(name) ?? []).filter((m) => m.repoId !== n.repoId);
      let chosen: { id: string } | undefined;
      let confidence = 0.5;
      if (targets) {
        const scoped = all.filter((m) => targets.has(m.fileId));
        if (scoped.length === 1) {
          chosen = scoped[0];
          confidence = 0.6; // import-scoped → more precise
        }
      }
      if (!chosen && all.length === 1) {
        chosen = all[0]; // federation-wide fallback
      }
      if (!chosen) continue; // ambiguous / unresolved
      pushCall({
        from: n.id,
        type: "CALLS",
        to: chosen.id,
        props: { resolution: "name_match", confidence, cross_repo: true, stitched: true, call_sites: 1 },
      });
    }
  }

  // 4) Cross-repo heritage (XRH-M3): inject INHERITS/IMPLEMENTS edges from each
  //    deriving type's external_heritage "<edge_type>|<base_name>" specs to the
  //    matching base TYPE node in another repo. Mirrors the Neo4j
  //    stitch_cross_repo_heritage: unique-only (ambiguous skipped, D-AMBIG),
  //    cross-repo only, and the edge type is refined from the child target's
  //    label (Interface→IMPLEMENTS, Class→INHERITS, else keep provisional).
  const typeByName = new Map<string, { id: string; repoId: string; label: string }[]>();
  for (const n of nodes) {
    const label = n.labels.find((l) => l === "Class" || l === "Interface" || l === "Enum");
    if (!label) continue;
    const nm = typeof n.props.name === "string" ? n.props.name : null;
    if (!nm) continue;
    (typeByName.get(nm) ?? typeByName.set(nm, []).get(nm)!).push({ id: n.id, repoId: n.repoId, label });
  }
  for (const arr of typeByName.values()) arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const n of nodes) {
    const eh = n.props.external_heritage;
    if (!Array.isArray(eh)) continue;
    const specs = [...new Set(eh.filter((x): x is string => typeof x === "string"))].sort();
    for (const spec of specs) {
      const sep = spec.indexOf("|");
      if (sep < 0) continue;
      const provisional = spec.slice(0, sep);
      const baseName = spec.slice(sep + 1);
      const all = (typeByName.get(baseName) ?? []).filter((m) => m.repoId !== n.repoId);
      if (all.length !== 1) continue; // D-AMBIG: unique only
      const b = all[0]!;
      const type = b.label === "Interface" ? "IMPLEMENTS" : b.label === "Class" ? "INHERITS" : provisional;
      edges.push({
        from: n.id,
        type,
        to: b.id,
        props: { resolution: "name_match", confidence: 0.7, cross_repo: true, stitched: true },
      });
    }
  }

  return { byId, callsFrom, callsTo, nodes, edges };
}
