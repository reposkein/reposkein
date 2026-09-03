/**
 * Pluggable EmbeddingProvider interface for semantic_find's optional embedding tier.
 *
 * Default (REPOSKEIN_EMBED_PROVIDER unset or "none") → providerFromEnv returns null
 * → semantic_find runs pure-lexical BM25F (byte-identical to baseline).
 *
 * Config env vars:
 *   REPOSKEIN_EMBED_PROVIDER  none | voyage | http    (default: none)
 *   REPOSKEIN_EMBED_MODEL     model id                (provider default when absent)
 *   REPOSKEIN_EMBED_DIMS      output dimension        (model default when absent)
 *   VOYAGE_API_KEY            API key for voyage provider
 *   REPOSKEIN_EMBED_URL       base URL for http provider
 */

export type EmbedKind = "document" | "query";

/**
 * What a single request to this provider may carry.
 *
 * The shared batcher (embed/batch.ts) enforces these; an adapter never chunks
 * for itself. `maxTokens` is measured with estimateTokens, a deterministic
 * length heuristic — it is a memory budget, not a billing figure.
 */
export interface BatchLimits {
  /** Max texts in one request. */
  maxItems: number;
  /** Max estimated tokens across one request's texts. */
  maxTokens: number;
}

export interface EmbeddingProvider {
  /** Stable provider id, e.g. "voyage". Forms part of the cache key. */
  id(): string;
  /** Stable model id, e.g. "voyage-code-3". Part of the cache key. */
  modelId(): string;
  /** Output vector dimensionality, e.g. 1024. Part of the cache key. */
  dims(): number;
  /** Per-request limits. Callers go through embedInBatches, which enforces them. */
  limits(): BatchLimits;
  /**
   * Embed ONE request's worth of texts. Implementations must NOT batch
   * internally: the caller has already sized this call against limits().
   * Splitting here would put the memory bound back inside each adapter, which
   * is exactly how the local HTTP adapter came to send whole corpora at once.
   *
   * kind maps to Voyage's input_type ("document" vs "query") — Voyage uses
   * asymmetric embeddings so this materially changes the vectors.
   * Returns one number[] per input, in order.
   */
  embedBatch(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

/**
 * Build a provider from env vars, or null if embeddings are disabled (default).
 * Returns null when REPOSKEIN_EMBED_PROVIDER is unset or "none".
 */
export async function providerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<EmbeddingProvider | null> {
  const providerName = (env["REPOSKEIN_EMBED_PROVIDER"] ?? "none").toLowerCase();
  if (providerName === "none" || providerName === "") return null;

  if (providerName === "voyage") {
    const { VoyageEmbeddingProvider } = await import("./providers/voyage.js");
    return new VoyageEmbeddingProvider(env);
  }

  if (providerName === "http") {
    const { HttpEmbeddingProvider } = await import("./providers/http.js");
    return new HttpEmbeddingProvider(env);
  }

  throw new Error(
    `Unknown REPOSKEIN_EMBED_PROVIDER: "${providerName}". Supported: none, voyage, http`
  );
}
