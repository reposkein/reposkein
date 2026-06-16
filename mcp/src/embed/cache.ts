/**
 * Derived embedding cache for semantic_find.
 *
 * Vectors are stored in `.reposkein/local/embeddings/<providerId>__<modelId>__d<dims>.jsonl`
 * — gitignored, never committed, never required.
 *
 * Cache key / invalidation:
 *   1. Filename encodes provider + model + dims (switching any → different file → miss).
 *   2. Per-row `doc_hash` must match hash of the freshly-built document string
 *      (changes to qualified_name, signature, semantic_summary, or file_path → re-embed).
 *   Note: CorpusNode does not expose the committed content_hash, so doc_hash is the
 *   sole per-row invalidation key. It covers all code/summary changes since the doc
 *   string is built from the same fields (qualified_name + signature + summary + file_path).
 *
 * Mirrors the atomic-write + best-effort pattern from mcp/src/store/sidecar.ts.
 * Any I/O or provider failure in embedCorpus must NOT propagate — callers catch and
 * fall back to the lexical result.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "./provider.js";
import type { CorpusNode } from "../store/GraphStore.js";

/** One cached record per embedded node. */
export interface EmbedRecord {
  id: string;
  /** doc_hash: SHA-256 of the embedded document string (invalidation key). */
  doc_hash: string;
  v: number[];
}

/** Build the document string for a corpus node (deterministic, same for all calls).
 *  voyage-code-3 is code-specialized, so including code-ish context plays to its strength.
 *  Document = qualified_name + optional signature + optional summary + file_path.
 */
export function buildDocString(node: CorpusNode): string {
  const parts: string[] = [node.qualified_name];
  if (node.signature) parts.push(node.signature);
  if (node.summary) parts.push(node.summary);
  parts.push(node.file_path);
  return parts.join("\n");
}

/** SHA-256 of a string, hex-encoded. */
export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Derive the cache file path for a given repo root + provider. */
export function cachePath(repoPath: string, provider: EmbeddingProvider): string {
  const name = `${provider.id()}__${provider.modelId()}__d${provider.dims()}`;
  return join(repoPath, ".reposkein", "local", "embeddings", `${name}.jsonl`);
}

/** Load cache into a Map keyed by node id. Missing file → empty map. Best-effort. */
export function loadCache(path: string): Map<string, EmbedRecord> {
  const map = new Map<string, EmbedRecord>();
  if (!existsSync(path)) return map;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof o["id"] === "string" &&
        typeof o["doc_hash"] === "string" &&
        Array.isArray(o["v"])
      ) {
        map.set(o["id"] as string, {
          id: o["id"] as string,
          doc_hash: o["doc_hash"] as string,
          v: o["v"] as number[],
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return map;
}

/** Rewrite the cache file (sorted by id). Atomic: write to .tmp then rename. Best-effort. */
export function saveCache(path: string, records: Map<string, EmbedRecord>): void {
  const lines = [...records.keys()].sort().map((id) => {
    const r = records.get(id)!;
    return JSON.stringify({ id: r.id, doc_hash: r.doc_hash, v: r.v });
  });
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "");
    renameSync(tmp, path);
  } catch {
    // best-effort; write failure must not break the tool call
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Embed the corpus nodes using the provider, leveraging the cache for nodes
 * whose doc_hash hasn't changed.
 *
 * Returns a Map<id, vector> for all nodes in corpus.
 * Only embeds nodes whose cache entry is missing or stale.
 * Persists updated cache to disk.
 *
 * Throws on embedding failure — callers must catch and fall back to lexical.
 */
export async function embedCorpus(
  provider: EmbeddingProvider,
  repoPath: string,
  corpus: CorpusNode[],
): Promise<Map<string, number[]>> {
  const path = cachePath(repoPath, provider);
  const cache = loadCache(path);

  // Compute document strings + hashes for all corpus nodes
  const docStrings = new Map<string, string>();
  const docHashes = new Map<string, string>();
  for (const node of corpus) {
    const doc = buildDocString(node);
    docStrings.set(node.id, doc);
    docHashes.set(node.id, sha256(doc));
  }

  // Identify which nodes need embedding (cache miss or stale doc_hash)
  const toEmbed: CorpusNode[] = [];
  for (const node of corpus) {
    const cached = cache.get(node.id);
    const isHit = cached !== undefined && cached.doc_hash === docHashes.get(node.id);
    if (!isHit) {
      toEmbed.push(node);
    }
  }

  // Embed only misses
  if (toEmbed.length > 0) {
    const texts = toEmbed.map((n) => docStrings.get(n.id)!);
    const vectors = await provider.embed(texts, "document");

    // Guard: provider must return exactly as many vectors as we sent.
    // A count mismatch means the provider is broken or mis-aligned — throw so
    // the caller's try/catch falls back to lexical.  Never write corrupt data.
    if (vectors.length !== toEmbed.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${toEmbed.length} texts — count mismatch; refusing to cache`
      );
    }

    const expectedDims = provider.dims();
    for (let i = 0; i < toEmbed.length; i++) {
      const vec = vectors[i];
      if (!Array.isArray(vec) || vec.length !== expectedDims) {
        throw new Error(
          `Embedding provider returned a vector with ${Array.isArray(vec) ? vec.length : "undefined"} dims at index ${i}; expected ${expectedDims} — refusing to cache`
        );
      }
      const node = toEmbed[i]!;
      cache.set(node.id, {
        id: node.id,
        doc_hash: docHashes.get(node.id)!,
        v: vec,
      });
    }

    saveCache(path, cache);
  }

  // Build result map for all corpus nodes
  const result = new Map<string, number[]>();
  for (const node of corpus) {
    const rec = cache.get(node.id);
    if (rec) {
      result.set(node.id, rec.v);
    }
  }
  return result;
}
