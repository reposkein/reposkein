import type { GraphStore } from "./GraphStore.js";
import type { TargetRow } from "../profile/types.js";
import {
  computeBodyHash,
  nodeIdSuffix,
  writeDecision,
  type AnchorHistoryEntry,
  type DecisionAnchor,
  type DecisionRecord,
} from "./decisions.js";

/** Anchor repair for `adr reanchor` / `reanchor_decision` (REP-24).
 *
 *  Reanchor is MECHANICAL pointer repair, distinct from reaffirm's semantic
 *  judgment: it rebinds an anchor only on a confident match — the id resolves
 *  under a live repo_id (suffix retry), or the recorded content hash matches
 *  exactly one live node — and preserves staleness (a suffix rebind keeps the
 *  recorded hash, so a stale flag survives the repair; clearing it is
 *  reaffirm_decision's job). Ambiguous and orphaned anchors are reported,
 *  never guessed. plan is pure; apply writes only when something rebinds, so
 *  a second run on the same graph is a byte-level no-op. */

export type ReanchorAction = "keep" | "rebind" | "stale" | "orphaned" | "ambiguous";

export interface AnchorPlanEntry {
  anchor: DecisionAnchor;
  action: ReanchorAction;
  /** Present iff action === "rebind". */
  to?: DecisionAnchor;
  /** Content-hash match count when ambiguous. */
  candidates?: number;
}

export interface ReanchorPlan {
  decision_id: string;
  anchors: AnchorPlanEntry[];
  changed: boolean;
  unresolved: number;
}

function liveAnchor(live: TargetRow, fallbackKind: string, hash: string | null): DecisionAnchor {
  return {
    node_id: live.id,
    path: live.file_path,
    name: live.qualified_name || live.name,
    kind: live.labels[0] ?? fallbackKind,
    hash,
  };
}

export async function planReanchor(
  store: GraphStore,
  repoIds: string[],
  rec: DecisionRecord
): Promise<ReanchorPlan> {
  const anchors: AnchorPlanEntry[] = [];
  for (const anchor of rec.anchors) {
    let live: TargetRow | null = await store.getNode(repoIds, anchor.node_id);
    if (!live) {
      const suffix = nodeIdSuffix(anchor.node_id);
      if (suffix) {
        for (const repoId of repoIds) {
          const candidate = `rs1:${repoId}${suffix}`;
          if (candidate === anchor.node_id) continue;
          live = await store.getNode(repoIds, candidate);
          if (live) break;
        }
      }
    }
    if (live) {
      if (live.id !== anchor.node_id) {
        // Suffix repair: rebind the pointer, keep the recorded hash so a
        // stale flag survives (reaffirm clears it, not reanchor).
        anchors.push({ anchor, action: "rebind", to: liveAnchor(live, anchor.kind, anchor.hash) });
      } else if (anchor.hash !== null && live.content_hash !== null && anchor.hash !== live.content_hash) {
        anchors.push({ anchor, action: "stale" });
      } else {
        anchors.push({ anchor, action: "keep" });
      }
      continue;
    }
    if (anchor.hash && store.findByContentHash) {
      const matches = await store.findByContentHash(repoIds, anchor.hash);
      if (matches.length === 1) {
        anchors.push({ anchor, action: "rebind", to: liveAnchor(matches[0]!, anchor.kind, anchor.hash) });
        continue;
      }
      if (matches.length > 1) {
        anchors.push({ anchor, action: "ambiguous", candidates: matches.length });
        continue;
      }
    }
    anchors.push({ anchor, action: "orphaned" });
  }
  return {
    decision_id: rec.id,
    anchors,
    changed: anchors.some((a) => a.action === "rebind"),
    unresolved: anchors.filter((a) => a.action === "orphaned" || a.action === "ambiguous").length,
  };
}

/** Applies a plan's rebinds. Returns the written record, or null when the
 *  plan changes nothing (in which case NOTHING is written — idempotence is
 *  the determinism gate). Body prose is never touched; the v2 body hash is
 *  anchor-independent, so re-signing here only upgrades pre-v2 records. */
export function applyReanchor(
  repoPath: string,
  rec: DecisionRecord,
  plan: ReanchorPlan,
  reanchoredAt: string
): DecisionRecord | null {
  if (!plan.changed) return null;
  const anchors = plan.anchors.map((a) => (a.action === "rebind" ? a.to! : a.anchor));
  const history: AnchorHistoryEntry[] = [
    ...(rec.anchor_history ?? []),
    { reanchored_at: reanchoredAt, anchors: rec.anchors },
  ];
  const updated: DecisionRecord = {
    ...rec,
    anchors,
    reanchored_at: reanchoredAt,
    anchor_history: history,
    body_hash: "",
  };
  updated.body_hash = computeBodyHash(updated);
  writeDecision(repoPath, updated);
  return updated;
}
