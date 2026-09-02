/**
 * Corpus vectors for `semantic_find`, behind the vector store.
 *
 * Replaces the JSON cache's "hand me every vector as number[]" shape. Callers
 * get a store they can ask for a ranked top-k; they never hold the corpus.
 */

import { join } from "node:path";
import type { EmbeddingProvider } from "./provider.js";
import { embedInBatches } from "./batch.js";
import { buildDocString, sanitizeModelId, sha256 } from "./cache.js";
import { openVectorStore, removeLegacyJsonCache, type VectorStore } from "./vectorStore.js";
import type { CorpusNode } from "../store/GraphStore.js";

/** Base path (no extension) for a provider's vectors in this repo. */
export function vectorBasePath(repoPath: string, provider: EmbeddingProvider): string {
  const name = `${provider.id()}__${sanitizeModelId(provider.modelId())}__d${provider.dims()}`;
  return join(repoPath, ".reposkein", "local", "embeddings", name);
}

/**
 * Ensure every corpus node has a current vector, and return the store.
 *
 * Only misses are embedded, in bounded batches, each flushed as it lands so an
 * interrupted cold run resumes rather than restarting.
 *
 * Throws on embedding failure — callers catch and fall back to lexical.
 */
export async function ensureCorpusVectors(
  provider: EmbeddingProvider,
  repoPath: string,
  corpus: CorpusNode[],
): Promise<VectorStore> {
  const base = vectorBasePath(repoPath, provider);
  // The pre-binary cache is superseded, and at 200k nodes it was over 4 GB of
  // dead JSON. Drop it the first time we write the store beside it.
  removeLegacyJsonCache(base);

  const store = openVectorStore(base, provider.dims());

  const docs = new Map<string, string>();
  const hashes = new Map<string, string>();
  const misses: CorpusNode[] = [];
  for (const node of corpus) {
    const doc = buildDocString(node);
    docs.set(node.id, doc);
    const hash = sha256(doc);
    hashes.set(node.id, hash);
    if (store.docHash(node.id) !== hash) misses.push(node);
  }
  if (misses.length === 0) return store;

  const texts = misses.map((n) => docs.get(n.id)!);
  const expectedDims = provider.dims();

  await embedInBatches(provider, texts, "document", (offset, vectors) => {
    const batch = [];
    for (let i = 0; i < vectors.length; i++) {
      const vec = vectors[i];
      if (!Array.isArray(vec) || vec.length !== expectedDims) {
        throw new Error(
          `Embedding provider returned a vector with ${Array.isArray(vec) ? vec.length : "undefined"} dims at index ${offset + i}; expected ${expectedDims} — refusing to store`
        );
      }
      const node = misses[offset + i]!;
      batch.push({ id: node.id, docHash: hashes.get(node.id)!, vector: vec });
    }
    store.upsertMany(batch);
    store.flush();
  });

  return store;
}
