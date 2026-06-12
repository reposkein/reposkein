import { statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CypherUnsupportedError,
  type GraphStore,
  type NeighborRow,
  type SummaryFields,
  type WriteSummaryResult,
} from "./GraphStore.js";
import type { TargetRow } from "../profile/types.js";
import {
  buildGraph,
  emptyGraph,
  type ParsedGraph,
  type ParsedNode,
} from "./jsonlGraph.js";
import { readSidecar, upsertSidecar, sidecarPath } from "./sidecar.js";

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function toTargetRow(n: ParsedNode): TargetRow {
  const name = str(n.props.name) ?? "";
  return {
    id: n.id,
    name,
    qualified_name: str(n.props.qualified_name) ?? name,
    file_path: str(n.props.file_path) ?? "",
    start_line: num(n.props.start_line),
    end_line: num(n.props.end_line),
    semantic_summary: str(n.props.semantic_summary),
    summary_of_hash: str(n.props.summary_of_hash),
    content_hash: str(n.props.content_hash),
    labels: n.labels.filter((l) => l !== "Rs"),
  };
}

function toNeighborRow(n: ParsedNode, edgeProps?: Record<string, unknown>): NeighborRow {
  const row: NeighborRow = {
    id: n.id,
    name: str(n.props.qualified_name) ?? str(n.props.name) ?? "",
    semantic_summary: str(n.props.semantic_summary),
    summary_of_hash: str(n.props.summary_of_hash),
    content_hash: str(n.props.content_hash),
  };
  if (edgeProps) {
    if (typeof edgeProps.resolution === "string") row.resolution = edgeProps.resolution;
    if (typeof edgeProps.confidence === "number") row.confidence = edgeProps.confidence;
  }
  return row;
}

const hasLabel = (n: ParsedNode, l: string): boolean => n.labels.includes(l);

/** A GraphStore over a single repo's committed .reposkein JSONL. Holds exactly
 *  the repo whose files it loaded; all methods scope on repo === this.repoId.
 *  Reloads when either JSONL file's mtime changes. writeSummary persists to the
 *  durable sidecar (.reposkein/local/summaries.jsonl) added in B1-M3. */
export class JsonlGraphStore implements GraphStore {
  private graph: ParsedGraph = emptyGraph();
  private mtime = -1;
  private readonly nodesPath: string;
  private readonly edgesPath: string;
  private readonly sidecarFile: string;

  constructor(
    repoPath: string,
    private readonly repoId: string
  ) {
    const dir = join(repoPath, ".reposkein");
    this.nodesPath = join(dir, "nodes.jsonl");
    this.edgesPath = join(dir, "edges.jsonl");
    this.sidecarFile = sidecarPath(repoPath);
    this.ensureFresh();
  }

  /** Reloads the graph if either file's mtime changed since last load. */
  private ensureFresh(): void {
    let m = 0;
    try {
      if (existsSync(this.nodesPath)) m = Math.max(m, statSync(this.nodesPath).mtimeMs);
      if (existsSync(this.edgesPath)) m = Math.max(m, statSync(this.edgesPath).mtimeMs);
    } catch {
      m = 0;
    }
    if (m === this.mtime) return;
    this.mtime = m;
    try {
      const nodesText = existsSync(this.nodesPath) ? readFileSync(this.nodesPath, "utf8") : "";
      const edgesText = existsSync(this.edgesPath) ? readFileSync(this.edgesPath, "utf8") : "";
      this.graph = buildGraph(nodesText, edgesText);
      // Overlay durable JSONL-mode summaries (visible even before reindex).
      for (const [id, rec] of readSidecar(this.sidecarFile)) {
        const n = this.graph.byId.get(id);
        if (n) {
          n.props.semantic_summary = rec.semantic_summary;
          n.props.summary_of_hash = rec.summary_of_hash;
          n.props.summary_model = rec.summary_model;
          n.props.summary_at = rec.summary_at;
          n.props.summary_by = rec.summary_by;
        }
      }
    } catch {
      this.graph = emptyGraph();
    }
  }

  private scoped(repoId: string): boolean {
    return repoId === this.repoId;
  }

  async getNode(repoId: string, id: string): Promise<TargetRow | null> {
    this.ensureFresh();
    if (!this.scoped(repoId)) return null;
    const n = this.graph.byId.get(id);
    return n ? toTargetRow(n) : null;
  }

  async resolveByPathAndName(repoId: string, filePath: string, name: string): Promise<TargetRow[]> {
    this.ensureFresh();
    if (!this.scoped(repoId)) return [];
    return this.graph.nodes
      .filter(
        (n) =>
          str(n.props.file_path) === filePath &&
          (hasLabel(n, "Function") || hasLabel(n, "Class")) &&
          (str(n.props.name) === name || str(n.props.qualified_name) === name)
      )
      .map(toTargetRow);
  }

  async resolveByName(repoId: string, name: string): Promise<TargetRow[]> {
    this.ensureFresh();
    if (!this.scoped(repoId)) return [];
    return this.graph.nodes
      .filter((n) => hasLabel(n, "Function") && str(n.props.name) === name)
      .map(toTargetRow);
  }

  async callers(repoId: string, id: string, limit: number): Promise<NeighborRow[]> {
    this.ensureFresh();
    if (!this.scoped(repoId)) return [];
    const rows: NeighborRow[] = [];
    for (const e of this.graph.callsTo.get(id) ?? []) {
      const x = this.graph.byId.get(e.from);
      if (x && hasLabel(x, "Function")) rows.push(toNeighborRow(x, e.props));
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.slice(0, limit);
  }

  async callees(repoId: string, id: string, limit: number): Promise<NeighborRow[]> {
    this.ensureFresh();
    if (!this.scoped(repoId)) return [];
    const rows: NeighborRow[] = [];
    for (const e of this.graph.callsFrom.get(id) ?? []) {
      const x = this.graph.byId.get(e.to);
      if (x && hasLabel(x, "Function")) rows.push(toNeighborRow(x, e.props));
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.slice(0, limit);
  }

  async calleesAt2Hops(repoId: string, id: string, limit: number): Promise<NeighborRow[]> {
    this.ensureFresh();
    if (!this.scoped(repoId)) return [];
    const seen = new Map<string, NeighborRow>();
    for (const e1 of this.graph.callsFrom.get(id) ?? []) {
      for (const e2 of this.graph.callsFrom.get(e1.to) ?? []) {
        const x = this.graph.byId.get(e2.to);
        if (x && hasLabel(x, "Function") && !seen.has(x.id)) {
          seen.set(x.id, toNeighborRow(x)); // no resolution/confidence at 2 hops
        }
      }
    }
    return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
  }

  async writeSummary(repoId: string, id: string, fields: SummaryFields): Promise<WriteSummaryResult> {
    this.ensureFresh();
    if (!this.scoped(repoId)) return { kind: "not_found" };
    const n = this.graph.byId.get(id);
    if (!n) return { kind: "not_found" };
    const chash = str(n.props.content_hash);
    if (chash === null) return { kind: "no_content_hash" };
    const oldSummary = str(n.props.semantic_summary);
    const oldHash = str(n.props.summary_of_hash);
    const stale_replaced = oldSummary !== null && oldHash !== chash;
    n.props.semantic_summary = fields.summary;
    n.props.summary_of_hash = chash;
    n.props.summary_model = fields.model;
    n.props.summary_at = fields.at;
    n.props.summary_by = fields.by;
    upsertSidecar(this.sidecarFile, {
      id,
      semantic_summary: fields.summary,
      summary_of_hash: chash,
      summary_model: fields.model,
      summary_at: fields.at,
      summary_by: fields.by,
    });
    return { kind: "ok", stale_replaced };
  }

  async federatedRepoIds(repoId: string): Promise<string[]> {
    this.ensureFresh();
    if (!this.scoped(repoId)) return [];
    const ids: string[] = [];
    for (const n of this.graph.nodes) {
      if (hasLabel(n, "Repository")) {
        const fid = str(n.props.federated_repo_id);
        if (fid) ids.push(fid);
      }
    }
    return ids;
  }

  async runRead(): Promise<Record<string, unknown>[]> {
    throw new CypherUnsupportedError();
  }

  async close(): Promise<void> {
    // nothing to close
  }
}
