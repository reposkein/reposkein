/** Ranked search — a small DETERMINISTIC weighted-field scorer over node
 *  records. No heavy deps. Each query token is scored against four fields with
 *  decreasing weight (name > qualified_name > file_path > semantic_summary);
 *  within a field the match quality (exact > prefix > word-boundary >
 *  substring) scales the field weight. A record must match EVERY token (AND
 *  semantics) to score; the total is the sum of best per-token field hits.
 *
 *  Ties break deterministically by name then id so results are stable.
 */

import type { NodeRecord } from "./model";

export type Field = "name" | "qualifiedName" | "filePath" | "semanticSummary";

/** Relative weight of each field (name dominates). */
const FIELD_WEIGHT: Record<Field, number> = {
  name: 10,
  qualifiedName: 6,
  filePath: 3,
  semanticSummary: 1.5,
};

const FIELDS: Field[] = ["name", "qualifiedName", "filePath", "semanticSummary"];

/** Match-quality multiplier for a single token against a single field value. */
function matchQuality(token: string, value: string): number {
  if (!value) return 0;
  const v = value.toLowerCase();
  if (v === token) return 1.0; // exact field match
  if (v.startsWith(token)) return 0.7; // prefix
  // word-boundary: token starts at a non-alphanumeric boundary.
  const idx = v.indexOf(token);
  if (idx < 0) return 0;
  const prev = idx === 0 ? "" : v[idx - 1]!;
  const boundary = idx === 0 || !/[a-z0-9]/.test(prev);
  return boundary ? 0.5 : 0.25; // word-boundary vs plain substring
}

function fieldValue(rec: NodeRecord, f: Field): string {
  switch (f) {
    case "name":
      return rec.name;
    case "qualifiedName":
      return rec.qualifiedName;
    case "filePath":
      return rec.filePath;
    case "semanticSummary":
      return rec.semanticSummary ?? "";
  }
}

export interface SearchHit {
  rec: NodeRecord;
  score: number;
  /** The single field that contributed the most to the score (for display). */
  topField: Field;
}

/** Tokenize a query: lowercase, split on whitespace, drop empties. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Rank records against a query. Returns up to `limit` hits sorted by score
 *  desc, then name asc, then id asc (fully deterministic). Records that don't
 *  match every token are excluded. Pure. */
export function rankSearch(
  records: Iterable<NodeRecord>,
  query: string,
  limit = 10
): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const rec of records) {
    let total = 0;
    let bestFieldScore = -1;
    let topField: Field = "name";
    let allTokensMatched = true;

    for (const token of tokens) {
      // Best field contribution for this token.
      let tokenBest = 0;
      let tokenBestField: Field = "name";
      for (const f of FIELDS) {
        const q = matchQuality(token, fieldValue(rec, f));
        if (q === 0) continue;
        const contrib = q * FIELD_WEIGHT[f];
        if (contrib > tokenBest) {
          tokenBest = contrib;
          tokenBestField = f;
        }
      }
      if (tokenBest === 0) {
        allTokensMatched = false;
        break;
      }
      total += tokenBest;
      if (tokenBest > bestFieldScore) {
        bestFieldScore = tokenBest;
        topField = tokenBestField;
      }
    }

    if (allTokensMatched) hits.push({ rec, score: total, topField });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rec.name !== b.rec.name) return a.rec.name < b.rec.name ? -1 : 1;
    return a.rec.id < b.rec.id ? -1 : a.rec.id > b.rec.id ? 1 : 0;
  });

  return hits.slice(0, limit);
}

/** Human label for a matched field (for the result row). */
export function fieldLabel(f: Field): string {
  switch (f) {
    case "name":
      return "name";
    case "qualifiedName":
      return "qualified name";
    case "filePath":
      return "path";
    case "semanticSummary":
      return "summary";
  }
}
