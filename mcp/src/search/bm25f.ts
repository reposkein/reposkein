/**
 * Deterministic BM25F lexical scorer for semantic_find.
 *
 * Architecture (design §3):
 *   - Tokenize by splitting on non-alphanumeric boundaries AND camelCase/PascalCase.
 *   - ASCII-lowercase, drop length-1 tokens. No stemming/stopwords.
 *   - Per-field weights: { qualified_name:10, name:8, summary:4, signature:2, file_path:1 }
 *   - BM25F with k1=1.2, b=0.75, IDF computed over whole corpus.
 *   - Deterministic: fixed iteration order, scores rounded to 6 decimal places,
 *     ties broken by node_id ascending.
 *   - Pure function: no clock, no random, no I/O.
 */

import type { CorpusNode } from "../store/GraphStore.js";

export interface Scored {
  node: CorpusNode;
  score: number;
  matched: string[];
}

// Field weights (design §3.2)
const WEIGHTS: Record<string, number> = {
  qualified_name: 10,
  name: 8,
  summary: 4,
  signature: 2,
  file_path: 1,
};

// Field names in fixed iteration order (for deterministic FP accumulation)
const FIELDS = ["qualified_name", "name", "summary", "signature", "file_path"] as const;
type Field = typeof FIELDS[number];

const K1 = 1.2;
const B = 0.75;
const SCORE_PRECISION = 1e6; // round to 6 decimal places

/**
 * Tokenize a string by:
 * 1. Split on non-alphanumeric characters.
 * 2. Split camelCase / PascalCase runs (lower→upper boundary, acronym+word boundary).
 * 3. ASCII-lowercase.
 * 4. Drop tokens of length ≤ 1.
 */
export function tokenize(s: string): string[] {
  // First split on non-alphanumeric boundaries (/, ., _, -, whitespace, #, (, ), <, >, :, etc.)
  const parts = s.split(/[^a-zA-Z0-9]+/);
  const tokens: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    // Split camelCase/PascalCase:
    //   - Insert split before an uppercase letter that follows a lowercase letter: e.g. getUserById → get|User|By|Id
    //   - Insert split before an uppercase letter followed by lowercase when preceded by uppercase: e.g. HTTPServer → HTTP|Server
    const subparts = part
      .replace(/([a-z])([A-Z])/g, "$1\0$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
      .split("\0");
    for (const sp of subparts) {
      const lower = sp.toLowerCase();
      if (lower.length > 1) {
        tokens.push(lower);
      }
    }
  }
  return tokens;
}

/** Build token multiset for a field value. */
function fieldTokens(value: string): string[] {
  return tokenize(value);
}

/** Count occurrences without allocating. The old form was
 *  `toks.filter((t) => t === qt).length`, which built a throwaway array for
 *  every (document x field x query token) — millions of them on a large
 *  corpus, for a number. */
function countOccurrences(toks: string[], needle: string): number {
  let n = 0;
  for (const t of toks) if (t === needle) n++;
  return n;
}

/** Tokenize one node's fields. Callers must NOT retain the result. */
function tokenizeFields(node: CorpusNode): { fields: Record<Field, string[]>; lengths: Record<Field, number> } {
  const fields = {} as Record<Field, string[]>;
  const lengths = {} as Record<Field, number>;
  for (const f of FIELDS) {
    const toks = fieldTokens((node as unknown as Record<string, string>)[f] ?? "");
    fields[f] = toks;
    lengths[f] = toks.length;
  }
  return { fields, lengths };
}

/**
 * Rank corpus nodes by BM25F for the given query, returning up to limit results.
 * Deterministic: identical corpus + query → identical ranking.
 *
 * Takes an ITERABLE, and iterates it twice — BM25F needs corpus-wide statistics
 * (average field lengths, document frequencies) before any document can be
 * scored, so the corpus cannot be consumed in a single pass. What it does NOT
 * do any more is RETAIN the corpus: the old form built a tokenized copy of all
 * five fields of every node and held it through scoring, then collected every
 * positive-scoring document before sorting. Retention is now bounded by
 * `limit`; tokens are discarded as soon as a document has been scored.
 *
 * The two passes cost tokenization twice. That is the trade: CPU proportional
 * to the corpus, memory proportional to the limit — which is the right way
 * round for a query path that runs inside an agent's tool call.
 *
 * The iterable must be re-iterable (an array, or a generator function's result
 * re-invoked). Results are identical to the single-pass form: same maths, and
 * the same total ordering (score desc, id asc) applied to a bounded heap.
 */
export function rankCorpus(corpus: Iterable<CorpusNode>, query: string, limit: number): Scored[] {
  if (limit <= 0 || !query.trim()) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const uniqueQueryTokens = [...new Set(queryTokens)];

  // Pass 1 — corpus statistics only. Field-length totals and document
  // frequencies; every token is dropped as soon as it has been counted.
  const totalFieldLen = {} as Record<Field, number>;
  for (const f of FIELDS) totalFieldLen[f] = 0;
  const dfMap = new Map<string, number>();
  for (const qt of uniqueQueryTokens) dfMap.set(qt, 0);
  let N = 0;

  for (const node of corpus) {
    N++;
    const { fields, lengths } = tokenizeFields(node);
    for (const f of FIELDS) totalFieldLen[f] += lengths[f];
    for (const qt of uniqueQueryTokens) {
      for (const f of FIELDS) {
        if (fields[f].includes(qt)) {
          dfMap.set(qt, dfMap.get(qt)! + 1);
          break;
        }
      }
    }
  }
  if (N === 0) return [];

  const avgFieldLen = {} as Record<Field, number>;
  for (const f of FIELDS) avgFieldLen[f] = totalFieldLen[f] / N;

  // Pass 2 — score, keeping only the best `limit`.
  const best: Scored[] = [];
  const worseThanWorst = (score: number, id: string): boolean => {
    const w = best[best.length - 1]!;
    if (score !== w.score) return score < w.score;
    return id > w.node.id; // ties: lower id wins, matching the sort below
  };

  for (const node of corpus) {
    const { fields, lengths } = tokenizeFields(node);
    let totalScore = 0;
    const matchedTokens = new Set<string>();

    for (const qt of uniqueQueryTokens) {
      const df = dfMap.get(qt) ?? 0;
      if (df === 0) continue;

      // IDF: ln(1 + (N - df + 0.5) / (df + 0.5))  — always positive for df < N
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      let weightedTf = 0;
      for (const f of FIELDS) {
        const tf = countOccurrences(fields[f], qt);
        if (tf === 0) continue;
        matchedTokens.add(qt);
        const fieldLen = lengths[f];
        const avgLen = avgFieldLen[f] > 0 ? avgFieldLen[f] : 1;
        const saturated = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (fieldLen / avgLen)));
        weightedTf += WEIGHTS[f]! * saturated;
      }

      totalScore += idf * weightedTf;
    }

    if (totalScore <= 0) continue;
    // Round to fixed precision to prevent cross-platform FP jitter from
    // reordering ties.
    const score = Math.round(totalScore * SCORE_PRECISION) / SCORE_PRECISION;
    if (best.length >= limit && worseThanWorst(score, node.id)) continue;

    best.push({ node, score, matched: [...matchedTokens].sort() });
    best.sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
    });
    if (best.length > limit) best.pop();
  }

  return best;
}
