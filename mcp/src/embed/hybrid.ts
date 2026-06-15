/**
 * Hybrid retrieval primitives for semantic_find.
 *
 * cosineRank: brute-force cosine similarity over cached vectors (in-process, no vector DB).
 * rrf: Reciprocal Rank Fusion (k=60) over lexical + cosine ranked lists.
 *
 * Both functions are pure + deterministic given identical inputs. Ties are broken by
 * ascending node id (same ordering convention as the rest of the store).
 *
 * Architecture note (design §3):
 *   - Lexical BM25F (always first) → lexical ranked list.
 *   - Cosine similarity over corpus vectors → cosine ranked list.
 *   - RRF fuses both lists → fused order.
 *   - On any embedding error → caller uses the lexical list as-is (fallback).
 */

/** A scored item in a ranked list. */
export interface RankedItem {
  id: string;
  score: number;
}

/**
 * Brute-force cosine similarity between a query vector and all corpus vectors.
 * Returns items with cosine score, sorted descending by score, then ascending by id (ties).
 */
export function cosineRank(
  queryVec: number[],
  corpusVecs: Map<string, number[]>,
): RankedItem[] {
  if (queryVec.length === 0 || corpusVecs.size === 0) return [];

  const queryNorm = l2norm(queryVec);
  if (queryNorm === 0) return [];

  const results: RankedItem[] = [];

  for (const [id, vec] of corpusVecs) {
    const vecNorm = l2norm(vec);
    if (vecNorm === 0) continue;
    const dot = dotProduct(queryVec, vec);
    const cosine = dot / (queryNorm * vecNorm);
    results.push({ id, score: cosine });
  }

  // Sort: descending score, ties broken by ascending id
  results.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return results;
}

/**
 * Reciprocal Rank Fusion (RRF) over two ranked lists.
 *
 * fused_score(node) = sum over lists of: weight / (k + rank(node))
 *   where rank is 1-based.
 *
 * k=60 (standard RRF default; robust to rank position).
 * Default weights: 1.0 for each list (equal fusion).
 * Scale-free: no score normalization needed (BM25F unbounded + cosine [-1,1]).
 * Ties broken by ascending id.
 *
 * @param lexicalList  Items ranked by BM25F (any items, even those not in cosineList).
 * @param cosineList   Items ranked by cosine similarity (any items, even those not in lexicalList).
 * @returns            Items sorted by fused RRF score, descending. Includes UNION of both lists.
 */
export function rrf(
  lexicalList: RankedItem[],
  cosineList: RankedItem[],
  k = 60,
): RankedItem[] {
  const fusedScores = new Map<string, number>();

  // Add contributions from lexical list (1-based rank)
  for (let i = 0; i < lexicalList.length; i++) {
    const item = lexicalList[i]!;
    const rank = i + 1;
    fusedScores.set(item.id, (fusedScores.get(item.id) ?? 0) + 1.0 / (k + rank));
  }

  // Add contributions from cosine list (1-based rank)
  for (let i = 0; i < cosineList.length; i++) {
    const item = cosineList[i]!;
    const rank = i + 1;
    fusedScores.set(item.id, (fusedScores.get(item.id) ?? 0) + 1.0 / (k + rank));
  }

  // Build result array and sort: descending fused score, ties by ascending id
  const result: RankedItem[] = [];
  for (const [id, score] of fusedScores) {
    result.push({ id, score });
  }
  result.sort((a, b) => {
    const diff = b.score - a.score;
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return result;
}

// ——— Vector math helpers ———

function dotProduct(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function l2norm(v: number[]): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}
