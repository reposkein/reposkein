/**
 * Tests for the shared batching seam: embedInBatches.
 *
 * The bound lives here, not in the adapters — an EmbeddingProvider can only
 * express ONE request (embedBatch), so no adapter can opt out of batching.
 */

import { describe, it, expect } from "vitest";
import { embedInBatches, estimateTokens, resolveBatchLimits } from "../src/embed/batch.js";
import type { EmbeddingProvider, EmbedKind, BatchLimits } from "../src/embed/provider.js";

/** Records exactly what each request received, so batching is observable. */
class RecordingProvider implements EmbeddingProvider {
  public calls: string[][] = [];
  constructor(
    private readonly _limits: BatchLimits,
    private readonly _dims = 4,
  ) {}
  id(): string { return "rec"; }
  modelId(): string { return "rec-model"; }
  dims(): number { return this._dims; }
  limits(): BatchLimits { return this._limits; }
  async embedBatch(texts: string[], _kind: EmbedKind): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map(() => new Array(this._dims).fill(0.5) as number[]);
  }
}

const HUGE = 1_000_000;

describe("embedInBatches — item limit", () => {
  it("never sends more texts in one request than the provider's item limit", async () => {
    const provider = new RecordingProvider({ maxItems: 2, maxTokens: HUGE });
    const texts = ["a", "b", "c", "d", "e"];

    await embedInBatches(provider, texts, "document", () => {}, {});

    expect(provider.calls.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(provider.calls.flat()).toEqual(texts);
  });

  it("reports each batch's offset so callers can flush incrementally", async () => {
    const provider = new RecordingProvider({ maxItems: 2, maxTokens: HUGE });
    const seen: Array<{ offset: number; count: number }> = [];

    await embedInBatches(provider, ["a", "b", "c", "d", "e"], "document", (offset, vectors) => {
      seen.push({ offset, count: vectors.length });
    }, {});

    expect(seen).toEqual([
      { offset: 0, count: 2 },
      { offset: 2, count: 2 },
      { offset: 4, count: 1 },
    ]);
  });

  it("makes no request at all for an empty input", async () => {
    const provider = new RecordingProvider({ maxItems: 2, maxTokens: HUGE });
    await embedInBatches(provider, [], "document", () => {}, {});
    expect(provider.calls).toEqual([]);
  });

  it("passes the embed kind through to the provider", async () => {
    const provider = new RecordingProvider({ maxItems: 8, maxTokens: HUGE });
    let seenKind: EmbedKind | null = null;
    class KindProvider extends RecordingProvider {
      override async embedBatch(texts: string[], kind: EmbedKind): Promise<number[][]> {
        seenKind = kind;
        return super.embedBatch(texts, kind);
      }
    }
    const p = new KindProvider({ maxItems: 8, maxTokens: HUGE });
    await embedInBatches(p, ["a"], "query", () => {}, {});
    expect(seenKind).toBe("query");
    void provider;
  });
});

describe("embedInBatches — token budget", () => {
  it("closes a batch when the next text would exceed the token budget", async () => {
    // estimateTokens is length/4 rounded up, plus a small per-text overhead.
    // 40 chars ≈ 10 tokens + overhead; a 30-token budget fits two, not three.
    const t = (n: number) => "x".repeat(n);
    const provider = new RecordingProvider({ maxItems: HUGE, maxTokens: 30 });

    await embedInBatches(provider, [t(40), t(40), t(40), t(40)], "document", () => {}, {});

    for (const call of provider.calls) {
      const tokens = call.reduce((sum, s) => sum + estimateTokens(s), 0);
      expect(tokens).toBeLessThanOrEqual(30);
    }
    expect(provider.calls.length).toBeGreaterThan(1);
    expect(provider.calls.flat().length).toBe(4);
  });

  it("sends a single over-budget text on its own rather than looping forever", async () => {
    const provider = new RecordingProvider({ maxItems: HUGE, maxTokens: 10 });
    const oversized = "y".repeat(10_000);

    await embedInBatches(provider, ["small", oversized, "small2"], "document", () => {}, {});

    const oversizedCall = provider.calls.find((c) => c.includes(oversized));
    expect(oversizedCall).toEqual([oversized]);
    expect(provider.calls.flat().length).toBe(3);
  });
});

describe("resolveBatchLimits", () => {
  it("uses the provider's own limits when nothing is configured", () => {
    const provider = new RecordingProvider({ maxItems: 64, maxTokens: 4096 });
    expect(resolveBatchLimits(provider, {})).toEqual({ maxItems: 64, maxTokens: 4096 });
  });

  it("lets the env lower the provider's limits", () => {
    const provider = new RecordingProvider({ maxItems: 64, maxTokens: 4096 });
    const limits = resolveBatchLimits(provider, {
      REPOSKEIN_EMBED_MAX_BATCH_ITEMS: "8",
      REPOSKEIN_EMBED_MAX_BATCH_TOKENS: "512",
    });
    expect(limits).toEqual({ maxItems: 8, maxTokens: 512 });
  });

  it("never lets the env raise a limit above what the provider declares", () => {
    const provider = new RecordingProvider({ maxItems: 64, maxTokens: 4096 });
    const limits = resolveBatchLimits(provider, {
      REPOSKEIN_EMBED_MAX_BATCH_ITEMS: "100000",
      REPOSKEIN_EMBED_MAX_BATCH_TOKENS: "100000",
    });
    expect(limits).toEqual({ maxItems: 64, maxTokens: 4096 });
  });

  it("ignores a malformed override rather than failing the query", () => {
    const provider = new RecordingProvider({ maxItems: 64, maxTokens: 4096 });
    const limits = resolveBatchLimits(provider, {
      REPOSKEIN_EMBED_MAX_BATCH_ITEMS: "not-a-number",
      REPOSKEIN_EMBED_MAX_BATCH_TOKENS: "0",
    });
    expect(limits).toEqual({ maxItems: 64, maxTokens: 4096 });
  });
});

describe("estimateTokens", () => {
  it("grows with text length", () => {
    expect(estimateTokens("x".repeat(400))).toBeGreaterThan(estimateTokens("x".repeat(40)));
  });

  it("is deterministic", () => {
    expect(estimateTokens("hello world")).toBe(estimateTokens("hello world"));
  });
});
