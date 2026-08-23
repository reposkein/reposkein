import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  anchorRepoIds,
  loadDecisionFiles,
  loadDecisions,
  resolveAnchorStates,
  verifyBodyHash,
  type DecisionRecord,
} from "../store/decisions.js";
import { JsonlGraphStore } from "../store/JsonlGraphStore.js";
import type { Check } from "./doctor.js";

/** ~Zimmermann ceiling: past this many active records, recall quality and the
 *  profile budget both degrade — time to deprecate/archive. */
const ACTIVE_BUDGET = 100;

const warn = (id: string, label: string, ok: boolean, detail: string, fix?: string): Check => ({
  id,
  label,
  ok,
  critical: false, // decision-log problems degrade; they never block startup
  detail,
  fix: ok ? undefined : fix,
});

function findCycle(records: Map<string, DecisionRecord>): string[] | null {
  // DFS along supersedes edges, tracking the actual path so the report names
  // exactly the cycle's members — not everything reachable along the way.
  for (const start of records.keys()) {
    const stack: { id: string; path: string[] }[] = [{ id: start, path: [start] }];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const { id, path } = stack.pop()!;
      for (const target of records.get(id)?.supersedes ?? []) {
        if (target === start) return [...path, target];
        if (!visited.has(target)) {
          visited.add(target);
          stack.push({ id: target, path: [...path, target] });
        }
      }
    }
  }
  return null;
}

/** Decision-log validation for `reposkein-mcp doctor`. Every check is
 *  non-critical (exit 0 with warnings): a damaged decision log must degrade,
 *  not block the graph. Returns [] only when there is no decisions dir. */
export function decisionChecks(repoPath: string): Check[] {
  const entries = loadDecisionFiles(repoPath);
  if (entries.length === 0) return [];

  const checks: Check[] = [];

  // 1) Every file parses.
  const malformed = entries.filter((e) => e.record === null).map((e) => e.file);
  checks.push(
    warn(
      "decisions_parse",
      "decision files parse",
      malformed.length === 0,
      malformed.length === 0
        ? `${entries.length} files`
        : `malformed: ${malformed.join(", ")}`,
      "fix or remove the malformed files (git conflict markers are the usual cause)"
    )
  );

  const parsed = entries.filter((e): e is { file: string; record: DecisionRecord } => e.record !== null);

  // 2) No duplicate ids across files (cross-branch same-day same-slug merges).
  const byId = new Map<string, DecisionRecord>();
  const dupes = new Set<string>();
  for (const { record } of parsed) {
    if (byId.has(record.id)) dupes.add(record.id);
    else byId.set(record.id, record);
  }
  checks.push(
    warn(
      "decisions_duplicates",
      "decision ids unique",
      dupes.size === 0,
      dupes.size === 0 ? `${byId.size} decisions` : `duplicate ids: ${[...dupes].join(", ")}`,
      "two branches minted the same id — keep one file per id (merge the bodies by hand if they differ)"
    )
  );

  // 3) Bodies unmodified since signing (immutability as invariant, not
  //    convention — reaffirm/supersede re-sign, hand edits don't).
  const tampered = parsed
    .filter(({ record }) => !verifyBodyHash(record))
    .map(({ record }) => record.id);
  checks.push(
    warn(
      "decisions_integrity",
      "decision bodies unmodified (body_hash)",
      tampered.length === 0,
      tampered.length === 0 ? "all bodies verify" : `hand-edited: ${tampered.join(", ")}`,
      "decision bodies are immutable — record a superseding decision instead of editing; revert the edit or re-record"
    )
  );

  // 4) Supersession references resolve, in both directions.
  const dangling: string[] = [];
  for (const rec of byId.values()) {
    for (const sid of rec.supersedes) {
      if (!byId.has(sid)) dangling.push(`${rec.id} → ${sid}`);
    }
    if (rec.superseded_by && !byId.has(rec.superseded_by)) {
      dangling.push(`${rec.id} ← ${rec.superseded_by}`);
    }
  }
  checks.push(
    warn(
      "decisions_refs",
      "supersession references resolve",
      dangling.length === 0,
      dangling.length === 0 ? "no dangling references" : `dangling: ${dangling.join(", ")}`,
      "a referenced decision file is missing — restore it or correct the reference"
    )
  );

  // 5) No supersession cycles.
  const cycle = findCycle(byId);
  checks.push(
    warn(
      "decisions_cycles",
      "supersession chain acyclic",
      cycle === null,
      cycle === null ? "no cycles" : `cycle: ${cycle.join(" → ")}`,
      "break the cycle — a decision cannot (transitively) supersede itself"
    )
  );

  // 6) Active-record budget.
  const active = [...byId.values()].filter(
    (r) => r.status === "accepted" || r.status === "proposed"
  ).length;
  checks.push(
    warn(
      "decisions_budget",
      `active decisions within budget (≤${ACTIVE_BUDGET})`,
      active <= ACTIVE_BUDGET,
      `${active} active records`,
      "the log is past the point where recall stays sharp — deprecate or supersede aged-out decisions"
    )
  );

  return checks;
}

/** Anchor drift against the live graph (async — opens the JSONL store).
 *  Skips silently when there is no graph or no anchored decision: doctor
 *  must work in a repo that has never indexed. Non-critical like every
 *  decision check. */
export async function anchorStateChecks(repoPath: string, repoId: string | null): Promise<Check[]> {
  const { decisions } = loadDecisions(repoPath);
  const anchored = decisions.filter((d) => d.anchors.length > 0);
  if (anchored.length === 0) return [];
  if (!repoId || !existsSync(join(repoPath, ".reposkein", "nodes.jsonl"))) return [];
  const store = new JsonlGraphStore(repoPath, repoId);
  try {
    const repoIds = await anchorRepoIds(store, repoId);
    let stale = 0, moved = 0, orphaned = 0;
    for (const rec of anchored) {
      for (const r of await resolveAnchorStates(store, repoIds, rec.anchors)) {
        if (r.state === "stale") stale++;
        else if (r.state === "moved") moved++;
        else if (r.state === "orphaned") orphaned++;
      }
    }
    const drifted = stale + moved + orphaned;
    return [
      warn(
        "decisions_anchors",
        "decision anchors current",
        drifted === 0,
        drifted === 0 ? "all anchors current" : `${moved} moved, ${stale} stale, ${orphaned} orphaned`,
        "run `reposkein-mcp adr reanchor` to repair moved anchors; reaffirm or supersede decisions whose stale anchors still conform"
      ),
    ];
  } finally {
    await store.close();
  }
}
