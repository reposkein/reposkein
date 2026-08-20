import { statSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute, sep } from "node:path";
import {
  CypherUnsupportedError,
  type CorpusNode,
  type GraphStore,
  type NeighborRow,
  type SummaryFields,
  type WriteSummaryResult,
} from "./GraphStore.js";
import type { TargetRow } from "../profile/types.js";
import {
  buildFederatedGraph,
  emptyGraph,
  type ParsedGraph,
  type ParsedNode,
  type RepoSource,
} from "./jsonlGraph.js";
import { loadAllSidecars, sidecarPaths, sidecarPath, upsertSidecar } from "./sidecar.js";
import {
  absorbSummarySource,
  emptyAccumulator,
  loadSummaryShards,
  recordSummaryConflicts,
  summaryShardsStamp,
} from "./summaryShards.js";

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Resolves a federated child dir from an untrusted committed root_path,
 *  rejecting absolute paths, `..`, and anything escaping `base`. */
function safeChildDir(base: string, rootPath: string): string | null {
  if (isAbsolute(rootPath)) return null;
  if (rootPath.split(/[\\/]/).includes("..")) return null;
  const baseAbs = resolve(base);
  const childAbs = resolve(baseAbs, rootPath);
  if (childAbs === baseAbs || childAbs.startsWith(baseAbs + sep)) return childAbs;
  return null;
}

function toTargetRow(n: ParsedNode): TargetRow {
  const name = str(n.props.name) ?? "";
  return {
    id: n.id,
    repo_id: n.repoId,
    name,
    qualified_name: str(n.props.qualified_name) ?? name,
    // File/Directory nodes carry `path` instead of `file_path`.
    file_path: str(n.props.file_path) ?? str(n.props.path) ?? "",
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
    repo_id: n.repoId,
    name: str(n.props.qualified_name) ?? str(n.props.name) ?? "",
    semantic_summary: str(n.props.semantic_summary),
    summary_of_hash: str(n.props.summary_of_hash),
    content_hash: str(n.props.content_hash),
  };
  if (edgeProps) {
    if (typeof edgeProps.resolution === "string") row.resolution = edgeProps.resolution;
    if (typeof edgeProps.confidence === "number") row.confidence = edgeProps.confidence;
    if (edgeProps.cross_repo === true) row.cross_repo = true;
  }
  return row;
}

const hasLabel = (n: ParsedNode, l: string): boolean => n.labels.includes(l);

/** A GraphStore over a repo's committed .reposkein JSONL.  In single-repo mode
 *  it loads only the root; in federated mode it also loads nested children
 *  (guarded, cycle-safe) and merges them into one graph.  All read methods
 *  scope per-node by repoIds — so non-federated reads (repoIds=[root]) see
 *  exactly the root (children invisible).
 *
 *  Reloads when either ROOT JSONL file's mtime changes (v1: a child-only
 *  change without a root change won't trigger reload — acceptable).
 *  writeSummary persists to this agent's durable sidecar
 *  (.reposkein/local/summaries-<agent>.jsonl). */
export class JsonlGraphStore implements GraphStore {
  private graph: ParsedGraph = emptyGraph();
  private stamp = "";
  private readonly repoPath: string;
  private readonly nodesPath: string;
  private readonly edgesPath: string;
  private readonly sidecarFile: string;

  constructor(
    repoPath: string,
    private readonly repoId: string
  ) {
    this.repoPath = repoPath;
    const dir = join(repoPath, ".reposkein");
    this.nodesPath = join(dir, "nodes.jsonl");
    this.edgesPath = join(dir, "edges.jsonl");
    this.sidecarFile = sidecarPath(repoPath);
    this.ensureFresh();
  }

  /** Gathers committed JSONL for the root + all transitively federated
   *  children (guarded, cycle-safe). Each child's repo_id comes from the proxy
   *  Repository node's federated_repo_id in the parent's nodes.jsonl. */
  private collectRepos(): RepoSource[] {
    const repos: RepoSource[] = [];
    const seen = new Set<string>();
    const visit = (dir: string, repoId: string) => {
      if (seen.has(repoId)) return;
      seen.add(repoId);
      const nodesPath = join(dir, ".reposkein", "nodes.jsonl");
      const edgesPath = join(dir, ".reposkein", "edges.jsonl");
      let nodesText = "";
      let edgesText = "";
      try {
        if (existsSync(nodesPath)) nodesText = readFileSync(nodesPath, "utf8");
        if (existsSync(edgesPath)) edgesText = readFileSync(edgesPath, "utf8");
      } catch {
        return;
      }
      repos.push({ repoId, nodesText, edgesText });
      // Discover children from this repo's Repository proxy nodes.
      for (const line of nodesText.split("\n")) {
        if (line.trim() === "") continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const labels = Array.isArray(obj.labels) ? obj.labels : [];
        if (!labels.includes("Repository")) continue;
        const fid = obj.federated_repo_id;
        const rp = obj.root_path;
        if (typeof fid === "string" && typeof rp === "string" && rp !== ".") {
          const childDir = safeChildDir(dir, rp);
          if (childDir) visit(childDir, fid);
        }
      }
    };
    visit(this.repoPath, this.repoId);
    return repos;
  }

  /** Reloads the graph when anything it reads has changed on disk.
   *
   *  The key covers the derived JSONL, the committed summary shards, AND every
   *  agent's sidecar. Keying on nodes/edges alone made a `git pull` that
   *  brought in only a teammate's shards invisible for the life of the process
   *  — the shards are committed and the derived graph is not, so that is the
   *  ordinary case. Leaving the sidecars out did the same to a second agent
   *  working the same checkout, which the overlay explicitly promises to
   *  surface. Stat calls only, O(shards + sidecars). */
  private freshnessKey(): string {
    let m = 0;
    try {
      if (existsSync(this.nodesPath)) m = Math.max(m, statSync(this.nodesPath).mtimeMs);
      if (existsSync(this.edgesPath)) m = Math.max(m, statSync(this.edgesPath).mtimeMs);
    } catch {
      m = 0;
    }
    return `${m}|${summaryShardsStamp(this.repoPath, sidecarPaths)}`;
  }

  private ensureFresh(): void {
    const key = this.freshnessKey();
    if (key === this.stamp) return;
    this.stamp = key;
    try {
      this.graph = buildFederatedGraph(this.collectRepos());
      // Overlay authored summaries: the committed shards first, then this
      // machine's sidecars as a strictly newer source, folded through the same
      // rules the indexer uses. So what the server serves is exactly what the
      // next `index` will write — including which side wins a divergence.
      //
      // The shard overlay only matters between indexes (`index` already grafts
      // them into nodes.jsonl), but that is the ordinary case: a teammate's
      // summaries arrive with a `git pull` long before anyone re-indexes.
      // Sidecars are every agent's, not just this process's, so two agents on
      // one checkout see each other's work.
      const shards = loadSummaryShards(this.repoPath);
      const overlay = emptyAccumulator();
      absorbSummarySource(overlay, {
        summaries: shards.summaries,
        conflicts: [],
        warnings: [],
      });
      absorbSummarySource(overlay, loadAllSidecars(this.repoPath));
      for (const [id, rec] of overlay.summaries) {
        const n = this.graph.byId.get(id);
        if (!n) continue;
        // Gated on the content hash for exactly the reason the indexer gates
        // its graft: a summary whose node has since changed is stale, and
        // serving it as current is worse than not serving it. Sidecar records
        // are stamped with the node's live hash at write time, so an unchanged
        // node passes this the same way a shard record does.
        if (rec.props.summary_of_hash !== n.props.content_hash) continue;
        for (const [k, v] of Object.entries(rec.props)) n.props[k] = v;
      }
      // Divergence losers — from a merged shard, or from two agents writing the
      // same node — are authored prose. Preserve them for a human rather than
      // discarding them on the read path.
      recordSummaryConflicts(this.repoPath, [...shards.conflicts, ...overlay.conflicts]);
    } catch {
      this.graph = emptyGraph();
    }
  }

  async getNode(repoIds: string[], id: string): Promise<TargetRow | null> {
    this.ensureFresh();
    const n = this.graph.byId.get(id);
    return n && repoIds.includes(n.repoId) ? toTargetRow(n) : null;
  }

  async findByContentHash(repoIds: string[], hash: string): Promise<TargetRow[]> {
    this.ensureFresh();
    return this.graph.nodes
      .filter((n) => repoIds.includes(n.repoId) && str(n.props.content_hash) === hash)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(toTargetRow);
  }

  async resolveByPathAndName(repoIds: string[], filePath: string, name: string): Promise<TargetRow[]> {
    this.ensureFresh();
    return this.graph.nodes
      .filter(
        (n) =>
          repoIds.includes(n.repoId) &&
          str(n.props.file_path) === filePath &&
          (hasLabel(n, "Function") || hasLabel(n, "Class")) &&
          (str(n.props.name) === name || str(n.props.qualified_name) === name)
      )
      .map(toTargetRow);
  }

  async resolveByName(repoIds: string[], name: string): Promise<TargetRow[]> {
    this.ensureFresh();
    return this.graph.nodes
      .filter((n) => repoIds.includes(n.repoId) && hasLabel(n, "Function") && str(n.props.name) === name)
      .map(toTargetRow);
  }

  async callers(repoIds: string[], id: string, limit: number): Promise<NeighborRow[]> {
    this.ensureFresh();
    const rows: NeighborRow[] = [];
    for (const e of this.graph.callsTo.get(id) ?? []) {
      const x = this.graph.byId.get(e.from);
      if (x && hasLabel(x, "Function") && repoIds.includes(x.repoId)) rows.push(toNeighborRow(x, e.props));
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.slice(0, limit);
  }

  async callees(repoIds: string[], id: string, limit: number): Promise<NeighborRow[]> {
    this.ensureFresh();
    const rows: NeighborRow[] = [];
    for (const e of this.graph.callsFrom.get(id) ?? []) {
      const x = this.graph.byId.get(e.to);
      if (x && hasLabel(x, "Function") && repoIds.includes(x.repoId)) rows.push(toNeighborRow(x, e.props));
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.slice(0, limit);
  }

  async calleesAt2Hops(repoIds: string[], id: string, limit: number): Promise<NeighborRow[]> {
    this.ensureFresh();
    const seen = new Map<string, NeighborRow>();
    for (const e1 of this.graph.callsFrom.get(id) ?? []) {
      for (const e2 of this.graph.callsFrom.get(e1.to) ?? []) {
        const x = this.graph.byId.get(e2.to);
        if (x && hasLabel(x, "Function") && repoIds.includes(x.repoId) && !seen.has(x.id)) {
          seen.set(x.id, toNeighborRow(x));
        }
      }
    }
    return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
  }

  async writeSummary(repoId: string, id: string, fields: SummaryFields): Promise<WriteSummaryResult> {
    this.ensureFresh();
    if (repoId !== this.repoId) return { kind: "not_found" };
    const n = this.graph.byId.get(id);
    if (!n || n.repoId !== this.repoId) return { kind: "not_found" };
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
    if (repoId !== this.repoId) return [];
    // Return ALL loaded repo ids except the root — collectRepos already walks
    // the full transitive closure (root → children → grandchildren …), so the
    // set of distinct repoIds present in graph.nodes is exactly the transitive
    // federated set.  This matches Neo4jGraphStore's FEDERATES_TO*1..8 semantics.
    const ids: string[] = [];
    for (const n of this.graph.nodes) {
      if (n.repoId !== this.repoId && !ids.includes(n.repoId)) {
        ids.push(n.repoId);
      }
    }
    return ids;
  }

  async searchCorpus(repoIds: string[]): Promise<CorpusNode[]> {
    this.ensureFresh();
    const CORPUS_LABELS = new Set(["Function", "Class", "Interface", "Enum"]);
    const rows: CorpusNode[] = [];
    for (const n of this.graph.nodes) {
      if (!repoIds.includes(n.repoId)) continue;
      const kind = n.labels.find((l) => CORPUS_LABELS.has(l));
      if (!kind) continue;
      const name = str(n.props.name) ?? "";
      rows.push({
        id: n.id,
        kind,
        name,
        qualified_name: str(n.props.qualified_name) ?? name,
        signature: str(n.props.signature) ?? "",
        summary: str(n.props.semantic_summary) ?? "",
        // File/Directory nodes carry `path` instead of `file_path`.
    file_path: str(n.props.file_path) ?? str(n.props.path) ?? "",
        repo_id: n.repoId,
      });
    }
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  async runRead(): Promise<Record<string, unknown>[]> {
    throw new CypherUnsupportedError();
  }

  async close(): Promise<void> {
    // nothing to close
  }
}
