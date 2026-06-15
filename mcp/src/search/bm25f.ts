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

interface NodeDoc {
  node: CorpusNode;
  fields: Record<Field, string[]>;
  fieldLengths: Record<Field, number>;
}

/**
 * Rank corpus nodes by BM25F for the given query, returning up to limit results.
 * Deterministic: identical corpus + query → identical ranking.
 */
export function rankCorpus(corpus: CorpusNode[], query: string, limit: number): Scored[] {
  if (corpus.length === 0 || !query.trim()) return [];

  // 1. Tokenize query
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const uniqueQueryTokens = [...new Set(queryTokens)];

  // 2. Build per-node documents in id-sorted order (corpus is already sorted by store)
  const docs: NodeDoc[] = corpus.map((node) => {
    const fields = {} as Record<Field, string[]>;
    const fieldLengths = {} as Record<Field, number>;
    for (const f of FIELDS) {
      const value = (node as unknown as Record<string, string>)[f] ?? "";
      const toks = fieldTokens(value);
      fields[f] = toks;
      fieldLengths[f] = toks.length;
    }
    return { node, fields, fieldLengths };
  });

  // 3. Compute average field lengths across corpus
  const avgFieldLen = {} as Record<Field, number>;
  for (const f of FIELDS) {
    const total = docs.reduce((sum, d) => sum + d.fieldLengths[f], 0);
    avgFieldLen[f] = docs.length > 0 ? total / docs.length : 1;
  }

  // 4. Build inverted index: token → set of doc indices (for IDF)
  const dfMap = new Map<string, number>();
  for (const qt of uniqueQueryTokens) {
    let df = 0;
    for (const doc of docs) {
      // Check if token appears in any field of this doc
      let found = false;
      for (const f of FIELDS) {
        if (doc.fields[f].includes(qt)) {
          found = true;
          break;
        }
      }
      if (found) df++;
    }
    dfMap.set(qt, df);
  }

  const N = docs.length;

  // 5. Score each document
  const scored: Scored[] = [];
  for (const doc of docs) {
    let totalScore = 0;
    const matchedTokens = new Set<string>();

    for (const qt of uniqueQueryTokens) {
      const df = dfMap.get(qt) ?? 0;
      if (df === 0) continue;

      // IDF: ln(1 + (N - df + 0.5) / (df + 0.5))  — always positive for df < N
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      // Weighted TF across fields (BM25F-style)
      let weightedTf = 0;
      for (const f of FIELDS) {
        const toks = doc.fields[f];
        const tf = toks.filter((t) => t === qt).length;
        if (tf === 0) continue;
        matchedTokens.add(qt);
        const fieldLen = doc.fieldLengths[f];
        const avgLen = avgFieldLen[f] > 0 ? avgFieldLen[f] : 1;
        // BM25 saturation with length normalization
        const saturated = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (fieldLen / avgLen)));
        weightedTf += WEIGHTS[f]! * saturated;
      }

      totalScore += idf * weightedTf;
    }

    if (totalScore > 0) {
      // Round to fixed precision to prevent cross-platform FP jitter from reordering ties
      const roundedScore = Math.round(totalScore * SCORE_PRECISION) / SCORE_PRECISION;
      scored.push({ node: doc.node, score: roundedScore, matched: [...matchedTokens].sort() });
    }
  }

  // 6. Sort: descending score, tie-break ascending node_id
  scored.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
  });

  return scored.slice(0, limit);
}
