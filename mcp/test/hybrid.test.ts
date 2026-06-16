/**
 * Tests for hybrid.ts: cosineRank, rrf.
 * All pure functions — no I/O, no provider, deterministic.
 */

import { describe, it, expect } from "vitest";
import { cosineRank, rrf } from "../src/embed/hybrid.js";
import type { RankedItem } from "../src/embed/hybrid.js";

// ——— cosineRank ———

describe("cosineRank", () => {
  it("returns empty for empty corpus", () => {
    expect(cosineRank([1, 0], new Map())).toEqual([]);
  });

  it("returns empty for zero-length query vector", () => {
    const vecs = new Map([["id:1", [1, 0]]]);
    expect(cosineRank([], vecs)).toEqual([]);
  });

  it("returns perfect score (1.0) for identical vectors", () => {
    const q = [1, 0, 0];
    const vecs = new Map([["id:1", [1, 0, 0]]]);
    const result = cosineRank(q, vecs);
    expect(result.length).toBe(1);
    expect(result[0]!.score).toBeCloseTo(1.0, 6);
  });

  it("returns near-zero score for orthogonal vectors", () => {
    const q = [1, 0];
    const vecs = new Map([["id:1", [0, 1]]]);
    const result = cosineRank(q, vecs);
    expect(result[0]!.score).toBeCloseTo(0, 6);
  });

  it("sorts by descending cosine score", () => {
    const q = [1, 0];
    // id:1 is parallel to query (score 1.0), id:2 is at 45° (score ~0.707)
    const vecs = new Map([
      ["id:1", [1, 0]],
      ["id:2", [1, 1]],
    ]);
    const result = cosineRank(q, vecs);
    expect(result[0]!.id).toBe("id:1");
    expect(result[1]!.id).toBe("id:2");
  });

  it("breaks ties by ascending id", () => {
    // Two vectors with the same direction → same cosine score
    const q = [1, 0];
    const vecs = new Map([
      ["id:b", [2, 0]], // same direction as [1, 0] → cosine = 1.0
      ["id:a", [3, 0]], // same direction → cosine = 1.0
    ]);
    const result = cosineRank(q, vecs);
    expect(result[0]!.id).toBe("id:a");
    expect(result[1]!.id).toBe("id:b");
  });

  it("is deterministic across calls", () => {
    const q = [0.5, 0.5, 0.7];
    const vecs = new Map([
      ["id:1", [1, 0, 0]],
      ["id:2", [0, 1, 0]],
      ["id:3", [0, 0, 1]],
    ]);
    const r1 = cosineRank(q, vecs);
    const r2 = cosineRank(q, vecs);
    expect(r1.map((x) => x.id)).toEqual(r2.map((x) => x.id));
  });

  it("skips zero-norm corpus vectors", () => {
    const q = [1, 0];
    const vecs = new Map([
      ["id:zero", [0, 0]],
      ["id:ok", [1, 0]],
    ]);
    const result = cosineRank(q, vecs);
    expect(result.map((r) => r.id)).not.toContain("id:zero");
    expect(result.map((r) => r.id)).toContain("id:ok");
  });

  it("M1: skips corpus vectors with wrong dimensionality (no NaN/partial score)", () => {
    const q = [1, 0]; // 2-dim query
    const vecs = new Map([
      ["id:wrong-dim", [1, 0, 0, 0]], // 4-dim — mismatch
      ["id:right-dim", [1, 0]],        // 2-dim — matches
    ]);
    const result = cosineRank(q, vecs);
    // dim-mismatched vector must be skipped entirely
    expect(result.map((r) => r.id)).not.toContain("id:wrong-dim");
    expect(result.map((r) => r.id)).toContain("id:right-dim");
    // No NaN scores
    for (const item of result) {
      expect(isNaN(item.score)).toBe(false);
    }
  });

  it("M1: query vector with wrong dims vs ALL corpus → returns empty (no plausible matches)", () => {
    const q = [1, 0, 0]; // 3-dim
    const vecs = new Map([
      ["id:a", [1, 0]], // 2-dim — mismatch
      ["id:b", [0, 1]], // 2-dim — mismatch
    ]);
    const result = cosineRank(q, vecs);
    expect(result.length).toBe(0);
  });
});

// ——— rrf ———

describe("rrf", () => {
  it("returns empty for empty lists", () => {
    expect(rrf([], [])).toEqual([]);
  });

  it("returns lexical items when cosine list is empty", () => {
    const lex: RankedItem[] = [
      { id: "id:1", score: 10 },
      { id: "id:2", score: 5 },
    ];
    const fused = rrf(lex, []);
    expect(fused[0]!.id).toBe("id:1");
    expect(fused[1]!.id).toBe("id:2");
  });

  it("RRF score for rank 1 is 1/(60+1) ≈ 0.0164", () => {
    const lex: RankedItem[] = [{ id: "id:1", score: 1 }];
    const fused = rrf(lex, []);
    expect(fused[0]!.score).toBeCloseTo(1 / 61, 6);
  });

  it("items in both lists get higher fused score than items in only one", () => {
    // id:1 appears in both lists at rank 1 → should beat id:2 which only appears in lexical
    const lex: RankedItem[] = [
      { id: "id:1", score: 10 },
      { id: "id:2", score: 9 },
    ];
    const cos: RankedItem[] = [
      { id: "id:1", score: 0.9 },
    ];
    const fused = rrf(lex, cos);
    const idx1 = fused.findIndex((r) => r.id === "id:1");
    const idx2 = fused.findIndex((r) => r.id === "id:2");
    expect(idx1).toBeLessThan(idx2);
  });

  it("includes UNION of both lists", () => {
    const lex: RankedItem[] = [{ id: "id:lex-only", score: 1 }];
    const cos: RankedItem[] = [{ id: "id:cos-only", score: 0.9 }];
    const fused = rrf(lex, cos);
    const ids = fused.map((r) => r.id);
    expect(ids).toContain("id:lex-only");
    expect(ids).toContain("id:cos-only");
  });

  it("breaks ties by ascending id", () => {
    // Equal RRF scores: both at rank 1 in their respective single list
    const lex: RankedItem[] = [{ id: "id:b", score: 1 }];
    const cos: RankedItem[] = [{ id: "id:a", score: 1 }];
    const fused = rrf(lex, cos);
    // id:a score = 1/(60+1) ≈ 0.0164; id:b score = 1/(60+1) ≈ 0.0164 (equal)
    // Tie broken by ascending id → "id:a" first
    expect(fused[0]!.id).toBe("id:a");
    expect(fused[1]!.id).toBe("id:b");
  });

  it("is deterministic across calls", () => {
    const lex: RankedItem[] = [
      { id: "id:1", score: 10 },
      { id: "id:2", score: 5 },
      { id: "id:3", score: 3 },
    ];
    const cos: RankedItem[] = [
      { id: "id:2", score: 0.9 },
      { id: "id:1", score: 0.7 },
    ];
    const r1 = rrf(lex, cos);
    const r2 = rrf(lex, cos);
    expect(r1.map((x) => x.id)).toEqual(r2.map((x) => x.id));
  });

  it("respects custom k parameter", () => {
    // Higher k → smaller rank differences → more uniform scores
    const lex: RankedItem[] = [
      { id: "id:1", score: 1 },
      { id: "id:2", score: 1 },
    ];
    const fused_k1 = rrf(lex, [], 1);
    const fused_k100 = rrf(lex, [], 100);
    // k=1: ranks 1/(1+1)=0.5, 1/(1+2)≈0.333 → bigger difference
    // k=100: ranks 1/(100+1)≈0.0099, 1/(100+2)≈0.0098 → very close
    const diff_k1 = fused_k1[0]!.score - fused_k1[1]!.score;
    const diff_k100 = fused_k100[0]!.score - fused_k100[1]!.score;
    expect(diff_k1).toBeGreaterThan(diff_k100);
  });
});
