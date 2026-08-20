import { neutralizeSummary } from "../guard/summaryValidation.js";
import { loadDecisions, type DecisionRecord, type DecisionStatus } from "../store/decisions.js";
import type { TargetRow } from "./types.js";

/** A decision surfaced on a profile/impact target: enough to know it exists
 *  and whether the code drifted under it — full rationale via get_decision. */
export interface GoverningDecision {
  id: string;
  title: string;
  status: DecisionStatus;
  /** "direct" — an anchor names this node; "contains" — a decision path
   *  (exact file or dir prefix ending "/") covers the target's file. */
  via: "direct" | "contains";
  /** Direct anchors only: recorded hash vs the target's current hash. */
  anchor_state?: "current" | "stale";
}

export interface TargetGovernance {
  /** Max 5, accepted before proposed before deprecated; then newest first. */
  decisions: GoverningDecision[];
  /** Accepted decisions whose direct anchor on this node is stale — re-read
   *  the decision and conform, supersede, or reaffirm. */
  needing_review: string[];
  truncated: boolean;
}

const MAX_GOVERNING = 5;

/** Only these statuses govern: rejected never held; superseded is history
 *  (reachable through the chain, not worth profile budget). */
const GOVERNING_ORDER: Partial<Record<DecisionStatus, number>> = {
  accepted: 0,
  proposed: 1,
  deprecated: 2,
};

/** `:<kind>:<rest>` — the id part that survives repo_id drift across forks. */
function idSuffix(nodeId: string): string | null {
  const m = /^rs1:[^:]+(:.+)$/.exec(nodeId);
  return m ? m[1]! : null;
}

function directAnchor(rec: DecisionRecord, targetId: string) {
  const targetSuffix = idSuffix(targetId);
  return rec.anchors.find(
    (a) => a.node_id === targetId || (targetSuffix !== null && idSuffix(a.node_id) === targetSuffix)
  );
}

function coversPath(rec: DecisionRecord, filePath: string): boolean {
  if (filePath === "") return false;
  for (const a of rec.anchors) {
    if (a.path === filePath) return true;
  }
  for (const p of rec.paths) {
    if (p === filePath) return true;
    if (p.endsWith("/") && filePath.startsWith(p)) return true;
  }
  return false;
}

/** Pure filesystem + target-row computation (no store round-trips): which
 *  decisions govern this node, and which of them the node has drifted under. */
export function governingDecisionsFor(repoPath: string, target: TargetRow): TargetGovernance {
  const { decisions } = loadDecisions(repoPath);
  const matched: GoverningDecision[] = [];
  const needing_review: string[] = [];
  for (const rec of decisions) {
    const order = GOVERNING_ORDER[rec.status];
    if (order === undefined) continue;
    const anchor = directAnchor(rec, target.id);
    let entry: GoverningDecision | null = null;
    if (anchor) {
      entry = {
        id: rec.id,
        title: neutralizeSummary(rec.title) ?? "",
        status: rec.status,
        via: "direct",
      };
      if (anchor.hash !== null && target.content_hash !== null) {
        entry.anchor_state = anchor.hash === target.content_hash ? "current" : "stale";
        if (entry.anchor_state === "stale" && rec.status === "accepted") {
          needing_review.push(rec.id);
        }
      }
    } else if (coversPath(rec, target.file_path)) {
      entry = {
        id: rec.id,
        title: neutralizeSummary(rec.title) ?? "",
        status: rec.status,
        via: "contains",
      };
    }
    if (entry) matched.push(entry);
  }
  matched.sort((a, b) => {
    const oa = GOVERNING_ORDER[a.status]!;
    const ob = GOVERNING_ORDER[b.status]!;
    if (oa !== ob) return oa - ob;
    // Ids embed the date — newest first, then lexicographic.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  const truncated = matched.length > MAX_GOVERNING;
  return { decisions: matched.slice(0, MAX_GOVERNING), needing_review, truncated };
}

/** Impact-shaped governance: for each decision, which of the given nodes it
 *  governs (the target plus impacted rows). */
export function governingDecisionsForNodes(
  repoPath: string,
  nodes: { node_id: string; file_path: string; content_hash?: string | null }[]
): { id: string; title: string; status: DecisionStatus; governs: string[] }[] {
  const { decisions } = loadDecisions(repoPath);
  const out: { id: string; title: string; status: DecisionStatus; governs: string[] }[] = [];
  for (const rec of decisions) {
    if (GOVERNING_ORDER[rec.status] === undefined) continue;
    const governs: string[] = [];
    for (const n of nodes) {
      const row: TargetRow = {
        id: n.node_id,
        repo_id: "",
        name: "",
        qualified_name: "",
        file_path: n.file_path,
        start_line: 0,
        end_line: 0,
        semantic_summary: null,
        summary_of_hash: null,
        content_hash: n.content_hash ?? null,
        labels: [],
      };
      if (directAnchor(rec, row.id) || coversPath(rec, row.file_path)) {
        governs.push(n.node_id);
      }
    }
    if (governs.length > 0) {
      out.push({
        id: rec.id,
        title: neutralizeSummary(rec.title) ?? "",
        status: rec.status,
        governs,
      });
    }
  }
  return out;
}
