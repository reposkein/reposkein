import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Reader for the committed authored summaries, `.reposkein/summaries/<xx>.jsonl`.
 *
 *  Sharding replaced a single `.reposkein/summaries.jsonl` for the reason
 *  `docs/migrations/2026-08-06-stop-committing-derived-graph.md` records: one
 *  committed file that every branch rewrites conflicts on every merge, and no
 *  `.gitattributes` rule can fix it, because a forge computes mergeability in a
 *  bare repo where tree-level attributes are never consulted. File granularity
 *  is the only thing that works there — the same reason decisions are one file
 *  each.
 *
 *  This module ONLY READS. The Rust indexer is the sole writer of committed
 *  shards, so byte-identical output has exactly one serializer to hold to it
 *  (serde_json and JSON.stringify differ on escapes and number formatting).
 *  Writes from this process go to the git-ignored per-agent sidecar, which the
 *  next `index` folds into the shards.
 *
 *  Reading never needs a shard key — `readdir` enumerates the files — which is
 *  why no BLAKE3 implementation is required on this side.
 *
 *  Tolerance is the other half. A shard is a MERGED file: it can carry git
 *  conflict markers, duplicate lines from a `merge=union` resolution, or two
 *  genuinely different summaries for the same node. None of that may take
 *  recall down, and none of it may silently destroy authored prose — the same
 *  contract `loadDecisions` keeps for a damaged decision file. */

export interface SummaryShardRecord {
  id: string;
  /** Every field except `id`, exactly as parsed. */
  props: Record<string, unknown>;
  /** The raw source line, which is also the divergence tiebreak. */
  line: string;
}

export interface LoadedSummaryShards {
  /** Winner per node id, insertion-ordered by id. */
  summaries: Map<string, SummaryShardRecord>;
  /** Divergence losers, preserved rather than dropped. */
  conflicts: SummaryShardRecord[];
  warnings: string[];
  /** Set when the pre-sharding `.reposkein/summaries.jsonl` is still present —
   *  doctor turns this into "run `reposkein-indexer index` to migrate". */
  legacyFilePresent: boolean;
}

export function summariesDir(repoPath: string): string {
  return join(repoPath, ".reposkein", "summaries");
}

/** The pre-sharding committed file. Still read (dual-read) for one release. */
export function legacySummariesPath(repoPath: string): string {
  return join(repoPath, ".reposkein", "summaries.jsonl");
}

export function conflictsPath(repoPath: string): string {
  return join(repoPath, ".reposkein", "local", "conflicts.jsonl");
}

/** Mirrors the Rust `is_shard_file_name`: exactly two lowercase hex chars. */
export function isShardFileName(name: string): boolean {
  return /^[0-9a-f]{2}\.jsonl$/.test(name);
}

/** A line git left behind from an unresolved textual merge. A canonical
 *  summary line always starts with `{`, so a marker run is damage, not data. */
export function isConflictMarker(line: string): boolean {
  return (
    line.startsWith("<<<<<<<") ||
    line.startsWith("=======") ||
    line.startsWith(">>>>>>>") ||
    line.startsWith("|||||||")
  );
}

function summaryAt(rec: SummaryShardRecord): string {
  const v = rec.props.summary_at;
  return typeof v === "string" ? v : "";
}

/** Byte-lexicographic comparison. JavaScript's `<` compares UTF-16 code units,
 *  which orders some astral/BMP pairs differently from the UTF-8 byte order
 *  Rust uses. Comparing the encoded bytes is what makes the two languages
 *  agree on every input, not just ASCII ones. */
function lineIsSmaller(a: string, b: string): boolean {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) < 0;
}

/** Deterministic winner between two records claiming the same node id:
 *  newer `summary_at`, then smaller raw line by UTF-8 byte order. Both are
 *  pure functions of bytes on disk, so every machine — and the Rust indexer —
 *  picks the same winner without coordinating. Kept in lockstep with the Rust
 *  `beats` by the shared vectors in `fixtures/summary-shard-vectors.json`. */
export function beats(candidate: SummaryShardRecord, incumbent: SummaryShardRecord): boolean {
  const ca = summaryAt(candidate);
  const ia = summaryAt(incumbent);
  if (ca !== ia) return ca > ia;
  return lineIsSmaller(candidate.line, incumbent.line);
}

/** Folds one file's text into an accumulator. Exported for the shared vectors. */
export function absorbSummaryLines(
  acc: { summaries: Map<string, SummaryShardRecord>; conflicts: SummaryShardRecord[]; warnings: string[] },
  source: string,
  text: string
): void {
  let markers = 0;
  let malformed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    if (isConflictMarker(line)) {
      markers++;
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformed++;
        continue;
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      malformed++;
      continue;
    }
    const id = obj.id;
    if (typeof id !== "string" || id === "") {
      malformed++;
      continue;
    }
    const { id: _drop, ...props } = obj;
    const rec: SummaryShardRecord = { id, props, line };
    const existing = acc.summaries.get(id);
    if (!existing) {
      acc.summaries.set(id, rec);
      continue;
    }
    // A union merge duplicating an unchanged line is not a conflict.
    if (existing.line === rec.line) continue;
    if (beats(rec, existing)) {
      acc.summaries.set(id, rec);
      acc.conflicts.push(existing);
    } else {
      acc.conflicts.push(rec);
    }
  }
  if (markers > 0) {
    acc.warnings.push(
      `${source}: skipped ${markers} git conflict-marker line(s); run \`reposkein-indexer index\` to rewrite the shard cleanly`
    );
  }
  if (malformed > 0) {
    acc.warnings.push(`${source}: skipped ${malformed} malformed line(s)`);
  }
}

/** Reads every committed shard plus the pre-sharding file, tolerantly.
 *  A missing directory is the normal state for a repo with no authored prose,
 *  and returns an empty result rather than an error. */
export function loadSummaryShards(repoPath: string): LoadedSummaryShards {
  const acc = {
    summaries: new Map<string, SummaryShardRecord>(),
    conflicts: [] as SummaryShardRecord[],
    warnings: [] as string[],
  };
  const dir = summariesDir(repoPath);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(isShardFileName).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    try {
      absorbSummaryLines(acc, `summaries/${name}`, readFileSync(join(dir, name), "utf8"));
    } catch {
      acc.warnings.push(`summaries/${name}: unreadable`);
    }
  }
  const legacy = legacySummariesPath(repoPath);
  const legacyFilePresent = existsSync(legacy);
  if (legacyFilePresent) {
    try {
      absorbSummaryLines(acc, "summaries.jsonl", readFileSync(legacy, "utf8"));
    } catch {
      acc.warnings.push("summaries.jsonl: unreadable");
    }
  }
  // Sorted by id so callers iterate deterministically.
  const summaries = new Map(
    [...acc.summaries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
  return { summaries, conflicts: acc.conflicts, warnings: acc.warnings, legacyFilePresent };
}

/** Merges divergence losers into the git-ignored `local/conflicts.jsonl`.
 *
 *  Deduped and sorted, so repeated reads converge instead of growing the file,
 *  and never truncating: a loser recorded by an earlier run (or by the indexer)
 *  stays. Best-effort — failing to record a conflict must not break a tool
 *  call. Mirrors the Rust `conflicts_to_jsonl`. */
export function recordSummaryConflicts(
  repoPath: string,
  losers: readonly SummaryShardRecord[]
): void {
  if (losers.length === 0) return;
  const path = conflictsPath(repoPath);
  const lines = new Set<string>();
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line.trim() !== "" && !isConflictMarker(line)) lines.add(line);
    }
  } catch {
    // no existing file
  }
  const before = lines.size;
  for (const l of losers) lines.add(l.line);
  if (lines.size === before) return;
  try {
    mkdirSync(join(repoPath, ".reposkein", "local"), { recursive: true });
    writeFileSync(path, [...lines].sort().join("\n") + "\n");
  } catch {
    // best-effort
  }
}

/** How many divergence losers are on record. Doctor surfaces this. */
export function countRecordedConflicts(repoPath: string): number {
  try {
    return readFileSync(conflictsPath(repoPath), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}
