import type { GraphStore } from "../store/GraphStore.js";
import type { ToolResult } from "./readCypher.js";
import { neutralizeSummary } from "../guard/summaryValidation.js";
import {
  anchorRepoIds,
  loadDecisions,
  nodeIdSuffix,
  resolveAnchorStates,
  type DecisionRecord,
  type DecisionStatus,
} from "../store/decisions.js";

export interface ListDecisionsArgs {
  status?: DecisionStatus;
  /** A node_id (matched against anchors) or a file path (matched against
   *  anchor paths and decision path prefixes). Disambiguation: anything
   *  starting "rs1:" is a node_id; everything else is a path. */
  anchor?: string;
  /** Case-insensitive substring over title + context + decision. */
  q?: string;
  limit?: number;
}

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function neutralize(s: string): string {
  return neutralizeSummary(s) ?? "";
}

/** True when the decision governs the given file path — an anchor records it
 *  exactly, or a decision path prefix (dir ending "/") contains it. */
export function governsPath(rec: DecisionRecord, filePath: string): boolean {
  for (const a of rec.anchors) {
    if (a.path === filePath) return true;
  }
  for (const p of rec.paths) {
    if (p === filePath) return true;
    if (p.endsWith("/") && filePath.startsWith(p)) return true;
  }
  return false;
}

function matchesAnchor(rec: DecisionRecord, anchor: string): boolean {
  if (anchor.startsWith("rs1:")) {
    // Suffix-tolerant, like every other decision surface — anchors recorded
    // in a fork/clone carry a different repo_id for the same node.
    const suffix = nodeIdSuffix(anchor);
    return rec.anchors.some(
      (a) => a.node_id === anchor || (suffix !== null && nodeIdSuffix(a.node_id) === suffix)
    );
  }
  return governsPath(rec, anchor);
}

function matchesText(rec: DecisionRecord, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    rec.title.toLowerCase().includes(needle) ||
    rec.context.toLowerCase().includes(needle) ||
    rec.decision.toLowerCase().includes(needle)
  );
}

/** Deterministic order: decided_at desc, id asc within a day. */
export function sortDecisions(decisions: DecisionRecord[]): DecisionRecord[] {
  return [...decisions].sort((a, b) => {
    if (a.decided_at !== b.decided_at) return a.decided_at < b.decided_at ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function makeListDecisions(store: GraphStore, repoId: string, repoPath: string) {
  return async (args: ListDecisionsArgs): Promise<ToolResult> => {
    try {
      const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
      const { decisions, warnings } = loadDecisions(repoPath);
      let filtered = decisions;
      if (args.status) filtered = filtered.filter((d) => d.status === args.status);
      if (args.anchor) filtered = filtered.filter((d) => matchesAnchor(d, args.anchor!));
      if (args.q) filtered = filtered.filter((d) => matchesText(d, args.q!));
      const ordered = sortDecisions(filtered);
      const page = ordered.slice(0, limit);
      const repoIds = await anchorRepoIds(store, repoId);
      const rows = [];
      for (const d of page) {
        const states = await resolveAnchorStates(store, repoIds, d.anchors);
        const counts = { current: 0, stale: 0, moved: 0, orphaned: 0 };
        for (const s of states) counts[s.state]++;
        rows.push({
          id: d.id,
          title: neutralize(d.title),
          status: d.status,
          decided_at: d.decided_at,
          anchor_counts: counts,
          ...(d.superseded_by ? { superseded_by: d.superseded_by } : {}),
        });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              decisions: rows,
              truncated: ordered.length > page.length,
              ...(warnings.length ? { warnings } : {}),
            }),
          },
        ],
      };
    } catch (e) {
      return err((e as Error).message);
    }
  };
}
