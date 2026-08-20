import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDecisions, nodeIdRepo, nodeIdSuffix } from "../store/decisions.js";
import { neutralizeSummary } from "../guard/summaryValidation.js";

/** TS mirror of the indexer's GraphDelta (indexer/crates/core/src/delta.rs). */
export interface GraphDeltaJson {
  added: string[];
  removed: string[];
  modified: string[];
  counts: { added: number; removed: number; modified: number };
  truncated: boolean;
}

export interface DecisionAffected {
  decision_id: string;
  title: string;
  why: "anchor_modified" | "anchor_removed" | "governed_path_changed";
}

/** Where hook-driven indexes park their delta: pre-commit / post-merge /
 *  post-checkout discard stdout, and post-merge (teammate changes landing) is
 *  exactly when decisions drift — the file bridges that gap to the next MCP
 *  call. Root repo only; nested repos' drift surfaces when they are reindexed
 *  through the MCP tools themselves. */
export function pendingDeltaPath(repoPath: string): string {
  return join(repoPath, ".reposkein", "local", "last_delta.json");
}

/** Reads AND consumes the pending delta (delete-on-read: each drift event is
 *  surfaced once). Corrupt files are consumed silently — a damaged advisory
 *  file must not wedge the pipeline. */
export function readPendingDelta(repoPath: string): GraphDeltaJson | null {
  const p = pendingDeltaPath(repoPath);
  if (!existsSync(p)) return null;
  let delta: GraphDeltaJson | null = null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as GraphDeltaJson;
    if (
      Array.isArray(parsed.added) &&
      Array.isArray(parsed.removed) &&
      Array.isArray(parsed.modified)
    ) {
      delta = parsed;
    }
  } catch {
    delta = null;
  }
  try {
    rmSync(p);
  } catch {
    // best-effort consume
  }
  return delta;
}

/** Drops the given node ids (suffix-tolerant) from the pending delta —
 *  called by record_decision, whose own refresh index would otherwise park a
 *  delta that flags the just-stamped decision as drifted on the next call.
 *  Deletes the file when nothing else remains; best-effort throughout. */
export function removeFromPendingDelta(repoPath: string, nodeIds: string[]): void {
  if (nodeIds.length === 0) return;
  const p = pendingDeltaPath(repoPath);
  if (!existsSync(p)) return;
  try {
    const delta = JSON.parse(readFileSync(p, "utf8")) as GraphDeltaJson;
    const drop = new Set(nodeIds.map(nodeIdSuffix).filter(Boolean) as string[]);
    const keep = (id: string) => {
      const s = nodeIdSuffix(id);
      return s === null || !drop.has(s);
    };
    const added = delta.added.filter(keep);
    const removed = delta.removed.filter(keep);
    const modified = delta.modified.filter(keep);
    if (added.length === 0 && removed.length === 0 && modified.length === 0 && !delta.truncated) {
      rmSync(p);
      return;
    }
    writeFileSync(
      p,
      JSON.stringify({
        added,
        removed,
        modified,
        counts: { added: added.length, removed: removed.length, modified: modified.length },
        truncated: delta.truncated,
      })
    );
  } catch {
    // best-effort: a damaged advisory file must not break recording
  }
}

/** Unions two deltas (id lists deduped; counts = union sizes). */
export function mergeDeltas(a: GraphDeltaJson, b: GraphDeltaJson): GraphDeltaJson {
  const union = (x: string[], y: string[]) => [...new Set([...x, ...y])].sort();
  const added = union(a.added, b.added);
  const removed = union(a.removed, b.removed);
  const modified = union(a.modified, b.modified);
  return {
    added,
    removed,
    modified,
    counts: { added: added.length, removed: removed.length, modified: modified.length },
    truncated: a.truncated || b.truncated,
  };
}

/** The path embedded in a File/Directory node id, or null. */
function pathOfNodeId(nodeId: string): string | null {
  const m = /^rs1:[^:]+:(?:file|dir):(.+)$/.exec(nodeId);
  return m ? m[1]! : null;
}

/** Cross-references a delta against the decision log: which accepted/proposed
 *  decisions govern something that just changed? Anchor matching is
 *  suffix-tolerant across repo_ids; PATH governance is scoped to the root
 *  repo (`rootRepoId`) — nested child repos use child-relative paths, a
 *  different coordinate system, and are governed via anchors instead.
 *  Deterministic order (by decision id). The skill rule: re-read each and
 *  conform, supersede, or reaffirm. */
export function decisionsAffectedBy(
  repoPath: string,
  delta: GraphDeltaJson,
  rootRepoId: string
): DecisionAffected[] {
  const { decisions } = loadDecisions(repoPath);
  const modifiedSuffixes = new Set(delta.modified.map(nodeIdSuffix).filter(Boolean) as string[]);
  const removedSuffixes = new Set(delta.removed.map(nodeIdSuffix).filter(Boolean) as string[]);
  const changed = [...delta.modified, ...delta.added, ...delta.removed]
    .map((id) => ({ path: pathOfNodeId(id), repo: nodeIdRepo(id) }))
    .filter((c): c is { path: string; repo: string | null } => c.path !== null);

  const out: DecisionAffected[] = [];
  for (const rec of decisions) {
    if (rec.status !== "accepted" && rec.status !== "proposed") continue;
    let why: DecisionAffected["why"] | null = null;
    for (const a of rec.anchors) {
      const suffix = nodeIdSuffix(a.node_id);
      if (suffix === null) continue;
      if (removedSuffixes.has(suffix)) {
        why = "anchor_removed";
        break;
      }
      if (modifiedSuffixes.has(suffix)) {
        why = "anchor_modified";
        // keep scanning — a removed anchor outranks a modified one
      }
    }
    if (!why) {
      const governs = (c: { path: string; repo: string | null }): boolean => {
        if (rec.anchors.some((a) => a.path === c.path && nodeIdRepo(a.node_id) === c.repo)) {
          return true;
        }
        if (c.repo !== rootRepoId) return false;
        return rec.paths.some((g) => g === c.path || (g.endsWith("/") && c.path.startsWith(g)));
      };
      if (changed.some(governs)) why = "governed_path_changed";
    }
    if (why) {
      out.push({
        decision_id: rec.id,
        title: neutralizeSummary(rec.title) ?? "",
        why,
      });
    }
  }
  return out;
}
