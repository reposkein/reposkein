import type { GraphStore } from "../store/GraphStore.js";
import type { ToolResult } from "./readCypher.js";
import { sanitizeDecisionFields } from "../guard/decisionValidation.js";
import {
  anchorRepoIds,
  computeBodyHash,
  loadDecisions,
  mintDecisionId,
  takenDecisionIds,
  writeDecision,
  type DecisionAnchor,
  type DecisionRecord,
  type DecisionTriggerKind,
} from "../store/decisions.js";
import { removeFromPendingDelta } from "../indexer/decisionsAffected.js";

export interface RecordDecisionArgs {
  title: string;
  context: string;
  decision: string;
  consequences?: string;
  alternatives?: string;
  /** Default "proposed" — agents record, humans (or an explicit instruction)
   *  ratify. Honest provenance: the committing party is often the agent. */
  status?: "proposed" | "accepted";
  anchor_node_ids?: string[];
  /** Literal file paths or directory prefixes ending "/". No globs. */
  anchor_paths?: string[];
  supersedes?: string[];
}

export interface DecisionToolDeps {
  /** Best-effort graph refresh before stamping anchor hashes, so a decision
   *  recorded right after an edit isn't born stale (the store reads the last
   *  index snapshot). Failures are swallowed — recording must not break. */
  refresh?: () => Promise<void>;
  today?: () => string;
}

function isoToday(): string {
  // Day-precision ISO date (PRD §6.2.5: no wall-clock timestamps in output).
  return new Date().toISOString().slice(0, 10);
}

const err = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const ok = (obj: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

/** A path anchor is a literal file path or a dir prefix ending "/" — never a
 *  glob (deterministic matching, no glob engine dependency). */
function invalidPath(p: string): boolean {
  return p.includes("*") || p.includes("?") || p.includes("[") || p.trim() === "";
}

export function makeRecordDecision(
  store: GraphStore,
  repoId: string,
  repoPath: string,
  deps: DecisionToolDeps = {}
) {
  const today = deps.today ?? isoToday;
  return async (args: RecordDecisionArgs): Promise<ToolResult> => {
    const prose = sanitizeDecisionFields({
      title: args.title,
      context: args.context,
      decision: args.decision,
      consequences: args.consequences,
      alternatives: args.alternatives,
    });
    if (!prose.ok) return err(prose.error);

    const anchorIds = args.anchor_node_ids ?? [];
    const paths = args.anchor_paths ?? [];
    const supersedes = args.supersedes ?? [];
    if (anchorIds.length > 20) return err("at most 20 anchor_node_ids");
    if (paths.length > 20) return err("at most 20 anchor_paths");
    if (supersedes.length > 5) return err("at most 5 supersedes");
    const badPath = paths.find(invalidPath);
    if (badPath !== undefined) {
      return err(`anchor_paths must be literal paths or dir prefixes ending "/" (no globs): ${badPath}`);
    }

    try {
      const { decisions } = loadDecisions(repoPath);
      const byId = new Map(decisions.map((d) => [d.id, d]));

      // Validate supersedes before writing anything (atomic refusal on typo).
      for (const sid of supersedes) {
        const target = byId.get(sid);
        if (!target) return err(`supersedes references unknown decision: ${sid}`);
        if (target.status === "superseded") {
          return err(`decision ${sid} is already superseded by ${target.superseded_by ?? "another decision"}`);
        }
      }

      // Refresh the graph before stamping so anchors reflect the working tree.
      if (deps.refresh) {
        try {
          await deps.refresh();
        } catch {
          // best-effort
        }
      }

      const repoIds = await anchorRepoIds(store, repoId);
      const anchors: DecisionAnchor[] = [];
      const unresolved: string[] = [];
      for (const nodeId of anchorIds) {
        const live = await store.getNode(repoIds, nodeId);
        if (!live) {
          unresolved.push(nodeId);
          continue;
        }
        anchors.push({
          node_id: live.id,
          path: live.file_path,
          name: live.qualified_name || live.name,
          kind: live.labels[0] ?? "",
          hash: live.content_hash,
        });
      }

      const date = today();
      // Filename-aware taken set: a damaged file's id must not be re-minted,
      // or writeDecision would rename over the hand-recoverable record.
      const id = mintDecisionId(date, prose.value.title, takenDecisionIds(repoPath));
      const trigger: { kind: DecisionTriggerKind } = { kind: "manual" };
      const rec: DecisionRecord = {
        id,
        title: prose.value.title,
        status: args.status ?? "proposed",
        context: prose.value.context,
        decision: prose.value.decision,
        anchors,
        paths,
        supersedes,
        decided_at: date,
        decided_by: process.env.REPOSKEIN_AGENT ?? "agent",
        trigger,
        body_hash: "",
      };
      if (prose.value.consequences !== undefined) rec.consequences = prose.value.consequences;
      if (prose.value.alternatives !== undefined) rec.alternatives = prose.value.alternatives;
      rec.body_hash = computeBodyHash(rec);
      writeDecision(repoPath, rec);

      // Flip superseded records after the new record exists; superseded_by
      // makes the chain walkable in both directions.
      for (const sid of supersedes) {
        const target = byId.get(sid)!;
        const flipped: DecisionRecord = { ...target, status: "superseded", superseded_by: id };
        writeDecision(repoPath, flipped);
      }

      // The refresh above (or the agent's own pre-record edit + hook index)
      // parked a drift delta that includes the very nodes this decision was
      // just stamped against. Subtract them so the next reindex doesn't flag
      // the freshly recorded decision as drifted; unrelated pending drift is
      // preserved.
      removeFromPendingDelta(repoPath, anchors.map((a) => a.node_id));

      return ok({
        ok: true,
        decision_id: id,
        status: rec.status,
        anchors: anchors.map((a) => ({ node_id: a.node_id, path: a.path, kind: a.kind })),
        unresolved,
        superseded: supersedes,
      });
    } catch (e) {
      return err((e as Error).message);
    }
  };
}
