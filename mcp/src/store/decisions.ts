import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { GraphStore } from "./GraphStore.js";
import type { TargetRow } from "../profile/types.js";

/** Architecture Decision Records (ADRs), committed one file per decision at
 *  .reposkein/decisions/<date>-<slug>.json. File-per-decision (not a single
 *  JSONL) so parallel branches recording decisions never merge-conflict on
 *  forges, which compute mergeability in a bare repo where .gitattributes
 *  union-merge is never consulted — the #35 lesson.
 *
 *  Ids are portable `adr:<date>-<slug>` (no repo_id: date+slug already
 *  disambiguates, and repo_id differs across forks/no-remote clones unless
 *  meta.json is committed). Anchor node_ids keep the full rs1: form but are
 *  matched tolerantly by suffix. Bodies are immutable after creation (checked
 *  via body_hash); only status/supersession/anchor re-stamping may change,
 *  and records are never machine-deleted — a decision about deleted code is
 *  still history. */

export type DecisionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "deprecated"
  | "superseded";

export interface DecisionAnchor {
  node_id: string;
  path: string;
  name: string;
  kind: string;
  /** content_hash of the anchored node at record (or reaffirm) time; null if
   *  the node had none. */
  hash: string | null;
}

export type DecisionTriggerKind = "manual" | "graph_delta" | "drift";

export interface DecisionRecord {
  id: string;
  title: string;
  status: DecisionStatus;
  context: string;
  decision: string;
  consequences?: string;
  alternatives?: string;
  anchors: DecisionAnchor[];
  /** Literal file paths or directory prefixes ending "/" (no globs). */
  paths: string[];
  supersedes: string[];
  superseded_by?: string;
  decided_at: string;
  decided_by: string;
  trigger: { kind: DecisionTriggerKind };
  /** Hash of the immutable body fields (see computeBodyHash). Lets doctor
   *  detect hand-edited bodies. */
  body_hash: string;
}

/** Anchor lifecycle at read time. Never deletes: the worst state is a flag. */
export type AnchorState = "current" | "stale" | "moved" | "orphaned";

export interface ResolvedAnchor extends DecisionAnchor {
  state: AnchorState;
  /** The live node id the anchor resolved to (differs from node_id for
   *  moved anchors and suffix matches across repo_ids). */
  resolved_node_id?: string;
}

const STATUSES: readonly DecisionStatus[] = [
  "proposed",
  "accepted",
  "rejected",
  "deprecated",
  "superseded",
];

/** Merge-damage tiebreak when the same id appears in two files: the more
 *  terminal status wins (a lost supersede flip is worse than a lost flag). */
const STATUS_PRECEDENCE: Record<DecisionStatus, number> = {
  superseded: 4,
  deprecated: 3,
  rejected: 2,
  accepted: 1,
  proposed: 0,
};

export function decisionsDir(repoPath: string): string {
  return join(repoPath, ".reposkein", "decisions");
}

/** Kebab-cases a title into the id slug: lowercase [a-z0-9-], capped. */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "decision";
}

/** Mints `adr:<date>-<slug>`, appending `.1`, `.2`, … while taken. */
export function mintDecisionId(date: string, title: string, taken: ReadonlySet<string>): string {
  const base = `adr:${date}-${slugify(title)}`;
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base}.${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** SHA-256 over the immutable body. Excludes status/superseded_by (lifecycle)
 *  and anchor hash values (re-stamped by reaffirm) — but covers WHICH nodes
 *  and paths the decision governs, and every prose field. */
export function computeBodyHash(rec: Omit<DecisionRecord, "body_hash">): string {
  const body = {
    alternatives: rec.alternatives ?? "",
    anchor_node_ids: rec.anchors.map((a) => a.node_id),
    consequences: rec.consequences ?? "",
    context: rec.context,
    decided_at: rec.decided_at,
    decided_by: rec.decided_by,
    decision: rec.decision,
    paths: rec.paths,
    supersedes: rec.supersedes,
    title: rec.title,
    trigger: rec.trigger.kind,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** File name for a decision id (`adr:` prefix stripped). */
export function decisionFileName(id: string): string {
  return `${id.replace(/^adr:/, "")}.json`;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortedKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Canonical bytes: `id` first, then sorted keys, 2-space indent, trailing LF.
 *  Pretty-printed (unlike the derived JSONL) because these files are authored
 *  history that humans review in PR diffs. */
export function canonicalizeDecision(rec: DecisionRecord): string {
  const { id, ...rest } = rec;
  const sorted = sortedKeys(rest) as Record<string, unknown>;
  const withOptionalsDropped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sorted)) {
    if (v === undefined) continue;
    withOptionalsDropped[k] = v;
  }
  return JSON.stringify({ id, ...withOptionalsDropped }, null, 2) + "\n";
}

/** Atomic write: temp file in the same dir, then rename. */
export function writeDecision(repoPath: string, rec: DecisionRecord): void {
  const dir = decisionsDir(repoPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, decisionFileName(rec.id));
  const tmp = join(dir, `.${decisionFileName(rec.id)}.tmp`);
  writeFileSync(tmp, canonicalizeDecision(rec));
  renameSync(tmp, file);
}

function parseDecision(obj: Record<string, unknown>): DecisionRecord | null {
  if (typeof obj.id !== "string" || !obj.id.startsWith("adr:")) return null;
  if (typeof obj.title !== "string" || typeof obj.context !== "string") return null;
  if (typeof obj.decision !== "string" || typeof obj.decided_at !== "string") return null;
  const status = obj.status;
  if (typeof status !== "string" || !STATUSES.includes(status as DecisionStatus)) return null;
  const anchorsRaw = Array.isArray(obj.anchors) ? obj.anchors : [];
  const anchors: DecisionAnchor[] = [];
  for (const a of anchorsRaw) {
    if (a === null || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (typeof o.node_id !== "string") continue;
    anchors.push({
      node_id: o.node_id,
      path: typeof o.path === "string" ? o.path : "",
      name: typeof o.name === "string" ? o.name : "",
      kind: typeof o.kind === "string" ? o.kind : "",
      hash: typeof o.hash === "string" ? o.hash : null,
    });
  }
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const triggerKind =
    obj.trigger !== null &&
    typeof obj.trigger === "object" &&
    typeof (obj.trigger as Record<string, unknown>).kind === "string"
      ? ((obj.trigger as Record<string, unknown>).kind as string)
      : "manual";
  const rec: DecisionRecord = {
    id: obj.id,
    title: obj.title,
    status: status as DecisionStatus,
    context: obj.context,
    decision: obj.decision,
    anchors,
    paths: strArray(obj.paths),
    supersedes: strArray(obj.supersedes),
    decided_at: obj.decided_at,
    decided_by: typeof obj.decided_by === "string" ? obj.decided_by : "unknown",
    trigger: {
      kind: (["manual", "graph_delta", "drift"] as const).includes(
        triggerKind as DecisionTriggerKind
      )
        ? (triggerKind as DecisionTriggerKind)
        : "manual",
    },
    body_hash: typeof obj.body_hash === "string" ? obj.body_hash : "",
  };
  if (typeof obj.consequences === "string") rec.consequences = obj.consequences;
  if (typeof obj.alternatives === "string") rec.alternatives = obj.alternatives;
  if (typeof obj.superseded_by === "string") rec.superseded_by = obj.superseded_by;
  return rec;
}

export interface LoadedDecisions {
  /** Sorted by id; deduped by id with status precedence. */
  decisions: DecisionRecord[];
  warnings: string[];
}

export interface DecisionFileEntry {
  file: string;
  /** null when the file is malformed (bad JSON, conflict markers, missing
   *  required fields). */
  record: DecisionRecord | null;
}

/** Raw per-file scan (no dedupe) — the substrate for loadDecisions and for
 *  doctor's duplicate/integrity checks. */
export function loadDecisionFiles(repoPath: string): DecisionFileEntry[] {
  const dir = decisionsDir(repoPath);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
  } catch {
    return [];
  }
  return files.sort().map((f) => {
    let record: DecisionRecord | null = null;
    try {
      record = parseDecision(JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
    } catch {
      record = null;
    }
    return { file: f, record };
  });
}

/** Loads every decision file. Tolerant: malformed files (conflict markers,
 *  bad JSON, missing fields) are skipped with a warning, never thrown — a
 *  damaged file must not take recall down. */
export function loadDecisions(repoPath: string): LoadedDecisions {
  const warnings: string[] = [];
  const byId = new Map<string, DecisionRecord>();
  for (const { file, record } of loadDecisionFiles(repoPath)) {
    if (!record) {
      warnings.push(`skipped malformed decision file: ${file}`);
      continue;
    }
    const existing = byId.get(record.id);
    if (!existing || STATUS_PRECEDENCE[record.status] > STATUS_PRECEDENCE[existing.status]) {
      byId.set(record.id, record);
    }
  }
  const decisions = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { decisions, warnings };
}

/** Repo ids for anchor resolution: the root plus its federated children —
 *  decisions live at the root but may govern nodes in nested repos. Falls
 *  back to the root alone if federation lookup fails. */
export async function anchorRepoIds(store: GraphStore, repoId: string): Promise<string[]> {
  try {
    return [repoId, ...(await store.federatedRepoIds(repoId))];
  } catch {
    return [repoId];
  }
}

/** The portion of a node id that survives repo_id drift: `:<kind>:<rest>`. */
function idSuffix(nodeId: string): string | null {
  const m = /^rs1:[^:]+(:.+)$/.exec(nodeId);
  return m ? m[1]! : null;
}

/** Resolves each anchor against the live graph:
 *  - current:  node id live (exact or repo_id-suffix match), hash unchanged
 *  - stale:    node id live, content differs since record time
 *  - moved:    id dead, but the recorded content hash matches a live node —
 *              the only signal that survives renames
 *  - orphaned: nothing matches; kept and flagged, never deleted */
export async function resolveAnchorStates(
  store: GraphStore,
  repoIds: string[],
  anchors: DecisionAnchor[]
): Promise<ResolvedAnchor[]> {
  const out: ResolvedAnchor[] = [];
  for (const anchor of anchors) {
    let live: TargetRow | null = await store.getNode(repoIds, anchor.node_id);
    if (!live) {
      // Fork tolerance: the anchor may carry a different repo_id than the
      // local checkout computes. Retry with each live repo id + the suffix.
      const suffix = idSuffix(anchor.node_id);
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
      const state: AnchorState =
        anchor.hash === null || live.content_hash === null || anchor.hash === live.content_hash
          ? "current"
          : "stale";
      out.push({ ...anchor, state, resolved_node_id: live.id });
      continue;
    }
    if (anchor.hash && store.findByContentHash) {
      const matches = await store.findByContentHash(repoIds, anchor.hash);
      if (matches.length > 0) {
        out.push({ ...anchor, state: "moved", resolved_node_id: matches[0]!.id });
        continue;
      }
    }
    out.push({ ...anchor, state: "orphaned" });
  }
  return out;
}
