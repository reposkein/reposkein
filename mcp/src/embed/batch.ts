/**
 * The batching seam for embeddings.
 *
 * An EmbeddingProvider can only express ONE request (embedBatch). Everything
 * that decides how much work a request may carry lives here, so no adapter can
 * opt out of the bound — the local HTTP adapter used to post an entire cold
 * corpus in a single request (~5 GB at 50k symbols), because chunking was
 * adapter-local and only the cloud adapter implemented it.
 *
 * Batches are handed to the caller as they complete, never accumulated, so peak
 * memory on the embed path is proportional to one batch rather than the corpus.
 *
 * Config env vars (both optional; may only LOWER a provider's declared limits):
 *   REPOSKEIN_EMBED_MAX_BATCH_ITEMS   max texts per request
 *   REPOSKEIN_EMBED_MAX_BATCH_TOKENS  max estimated tokens per request
 */

import type { BatchLimits, EmbeddingProvider, EmbedKind } from "./provider.js";

/**
 * Deterministic token estimate: ~4 characters per token, plus a small
 * per-text overhead for the delimiters and special tokens a server adds.
 *
 * This is a memory budget, not a billing figure — it only has to be
 * monotonic in length and never wildly under-count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 2;
}

/** Read a positive-integer env override, or undefined when absent/malformed. */
function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * The limits actually applied to a provider: its own, optionally lowered by env.
 *
 * The env can only tighten. A provider's declared limit is a hard fact about
 * its backend (Voyage rejects >1000 inputs); letting an env var exceed it would
 * turn a memory knob into a source of 4xx errors.
 */
export function resolveBatchLimits(
  provider: EmbeddingProvider,
  env: NodeJS.ProcessEnv = process.env,
): BatchLimits {
  const declared = provider.limits();
  const items = positiveInt(env["REPOSKEIN_EMBED_MAX_BATCH_ITEMS"]);
  const tokens = positiveInt(env["REPOSKEIN_EMBED_MAX_BATCH_TOKENS"]);
  return {
    maxItems: items === undefined ? declared.maxItems : Math.min(items, declared.maxItems),
    maxTokens: tokens === undefined ? declared.maxTokens : Math.min(tokens, declared.maxTokens),
  };
}

/**
 * Embed `texts` in bounded requests, handing each batch's vectors to `onBatch`
 * as it arrives together with the offset into `texts` it starts at.
 *
 * Nothing is accumulated here: the caller decides what to keep. That is what
 * lets embedCorpus persist progress per batch, so an interrupted cold run
 * resumes instead of restarting.
 *
 * A text that exceeds maxTokens on its own is sent alone rather than dropped or
 * split — the server truncates it if it must, and the loop always advances.
 *
 * Throws on the first provider failure; callers fall back to lexical.
 */
export async function embedInBatches(
  provider: EmbeddingProvider,
  texts: string[],
  kind: EmbedKind,
  onBatch: (offset: number, vectors: number[][]) => void | Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (texts.length === 0) return;
  const { maxItems, maxTokens } = resolveBatchLimits(provider, env);

  let start = 0;
  while (start < texts.length) {
    let end = start;
    let tokens = 0;
    while (end < texts.length) {
      const next = estimateTokens(texts[end]!);
      // Always take at least one text, however oversized, so the loop advances.
      if (end > start && (end - start >= maxItems || tokens + next > maxTokens)) break;
      tokens += next;
      end++;
      if (end - start >= maxItems) break;
    }

    const batch = texts.slice(start, end);
    const vectors = await provider.embedBatch(batch, kind);
    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for a batch of ${batch.length} texts — count mismatch`
      );
    }
    await onBatch(start, vectors);
    start = end;
  }
}
