/**
 * Tests for the EmbeddingProvider interface and providerFromEnv factory.
 * All tests are offline (no real API keys/network). Uses a MockProvider.
 */

import { describe, it, expect } from "vitest";
import { providerFromEnv } from "../src/embed/provider.js";
import type { EmbeddingProvider, EmbedKind } from "../src/embed/provider.js";

/**
 * MockProvider: deterministic fake embeddings from a simple hash of the text.
 * Used by all embedding-related tests to avoid real API calls.
 */
export class MockProvider implements EmbeddingProvider {
  private readonly _id: string;
  private readonly _modelId: string;
  private readonly _dims: number;
  public embedCallCount = 0;
  public lastTexts: string[] = [];
  public lastKind: EmbedKind | null = null;
  /** If set, embed() will throw this error (for fallback tests). */
  public throwError: Error | null = null;

  constructor(opts: { id?: string; modelId?: string; dims?: number } = {}) {
    this._id = opts.id ?? "mock";
    this._modelId = opts.modelId ?? "mock-model-v1";
    this._dims = opts.dims ?? 4;
  }

  id(): string { return this._id; }
  modelId(): string { return this._modelId; }
  dims(): number { return this._dims; }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    this.embedCallCount++;
    this.lastTexts = texts;
    this.lastKind = kind;

    if (this.throwError) throw this.throwError;

    return texts.map((t) => hashVec(t, this._dims));
  }
}

/**
 * Deterministic fake vector: hash the text into `dims` floats in [0,1].
 * Different texts produce different vectors; same text always produces the same vector.
 */
export function hashVec(text: string, dims: number): number[] {
  // Simple polynomial hash seeded per position to spread values
  const v: number[] = [];
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) & 0xffffffff;
  }
  for (let d = 0; d < dims; d++) {
    h = ((h << 5) + h + d) & 0xffffffff;
    v.push(((h >>> 0) % 10001) / 10000);
  }
  return v;
}

// ——— providerFromEnv tests ———

describe("providerFromEnv", () => {
  it("returns null when REPOSKEIN_EMBED_PROVIDER is unset (default-off)", async () => {
    const p = await providerFromEnv({});
    expect(p).toBeNull();
  });

  it("returns null when REPOSKEIN_EMBED_PROVIDER=none", async () => {
    const p = await providerFromEnv({ REPOSKEIN_EMBED_PROVIDER: "none" });
    expect(p).toBeNull();
  });

  it("returns null when REPOSKEIN_EMBED_PROVIDER=NONE (case-insensitive)", async () => {
    const p = await providerFromEnv({ REPOSKEIN_EMBED_PROVIDER: "NONE" });
    expect(p).toBeNull();
  });

  it("returns a VoyageEmbeddingProvider when REPOSKEIN_EMBED_PROVIDER=voyage + key set", async () => {
    const p = await providerFromEnv({
      REPOSKEIN_EMBED_PROVIDER: "voyage",
      VOYAGE_API_KEY: "test-key-abc",
    });
    expect(p).not.toBeNull();
    expect(p!.id()).toBe("voyage");
    expect(p!.modelId()).toBe("voyage-code-3"); // default
    expect(p!.dims()).toBe(1024);               // default
  });

  it("voyage provider respects REPOSKEIN_EMBED_MODEL and REPOSKEIN_EMBED_DIMS", async () => {
    const p = await providerFromEnv({
      REPOSKEIN_EMBED_PROVIDER: "voyage",
      VOYAGE_API_KEY: "test-key",
      REPOSKEIN_EMBED_MODEL: "voyage-code-3",
      REPOSKEIN_EMBED_DIMS: "512",
    });
    expect(p!.modelId()).toBe("voyage-code-3");
    expect(p!.dims()).toBe(512);
  });

  it("throws when REPOSKEIN_EMBED_PROVIDER=voyage but VOYAGE_API_KEY missing", async () => {
    await expect(
      providerFromEnv({ REPOSKEIN_EMBED_PROVIDER: "voyage" })
    ).rejects.toThrow(/VOYAGE_API_KEY/);
  });

  it("returns an HttpEmbeddingProvider when REPOSKEIN_EMBED_PROVIDER=http + URL set", async () => {
    const p = await providerFromEnv({
      REPOSKEIN_EMBED_PROVIDER: "http",
      REPOSKEIN_EMBED_URL: "http://127.0.0.1:8080/embed",
      REPOSKEIN_EMBED_MODEL: "voyage-4-nano",
    });
    expect(p).not.toBeNull();
    expect(p!.id()).toBe("http");
    expect(p!.modelId()).toBe("voyage-4-nano");
  });

  it("throws for unknown provider", async () => {
    await expect(
      providerFromEnv({ REPOSKEIN_EMBED_PROVIDER: "unknown-provider" })
    ).rejects.toThrow(/Unknown REPOSKEIN_EMBED_PROVIDER/);
  });
});

// ——— MockProvider self-tests ———

describe("MockProvider", () => {
  it("produces deterministic vectors of the correct dimension", () => {
    const p = new MockProvider({ dims: 8 });
    const v1 = hashVec("hello world", 8);
    const v2 = hashVec("hello world", 8);
    expect(v1).toEqual(v2);
    expect(v1.length).toBe(8);
  });

  it("produces different vectors for different texts", () => {
    const v1 = hashVec("auth", 4);
    const v2 = hashVec("billing", 4);
    expect(v1).not.toEqual(v2);
  });

  it("tracks embed calls and records arguments", async () => {
    const p = new MockProvider({ dims: 4 });
    expect(p.embedCallCount).toBe(0);
    await p.embed(["a", "b"], "document");
    expect(p.embedCallCount).toBe(1);
    expect(p.lastTexts).toEqual(["a", "b"]);
    expect(p.lastKind).toBe("document");
  });

  it("throws when throwError is set (for fallback testing)", async () => {
    const p = new MockProvider();
    p.throwError = new Error("simulated network failure");
    await expect(p.embed(["x"], "query")).rejects.toThrow("simulated network failure");
  });
});
