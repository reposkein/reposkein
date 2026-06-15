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

export interface EmbeddingProvider {
  /** Stable provider id, e.g. "voyage". Forms part of the cache key. */
  id(): string;
  /** Stable model id, e.g. "voyage-code-3". Part of the cache key. */
  modelId(): string;
  /** Output vector dimensionality, e.g. 1024. Part of the cache key. */
  dims(): number;
  /**
   * Embed a batch of texts.
   * kind maps to Voyage's input_type ("document" vs "query") — Voyage uses
   * asymmetric embeddings so this materially changes the vectors.
   * Returns one number[] per input, in order.
   */
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
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
