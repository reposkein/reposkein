/**
 * semantic_find tool — lexical (BM25F) + optional hybrid embedding entry-point discovery.
 *
 * Cold-start seed finder: answers "where is X?" when the agent has no node_id
 * or exact identifier. Returns ranked node_ids ready for get_context_profile.
 *
 * Default behaviour (REPOSKEIN_EMBED_PROVIDER unset/none):
 *   Pure-lexical BM25F — byte-identical to the pre-embeddings baseline.
 *
 * With a provider configured:
 *   Hybrid: BM25F lexical + cosine similarity, fused via RRF (k=60).
 *   On ANY embedding error → silently falls back to pure-lexical (never breaks the tool).
 *   The lexical ranking is always computed first, so fallback is free.
 *
 * Architecture: calls store.searchCorpus to load the eligible node set, then
 * the shared BM25F scorer ranks in TypeScript — byte-identical for both JSONL
 * and Neo4j backends. No Neo4j vector index used.
 */

import type { GraphStore } from "../store/GraphStore.js";
import { federationIds } from "../store/federation.js";
import { rankCorpus } from "../search/bm25f.js";
import type { ToolResult } from "./readCypher.js";
import type { EmbeddingProvider } from "../embed/provider.js";
import { providerFromEnv } from "../embed/provider.js";
import { embedCorpus } from "../embed/cache.js";
import { cosineRank, rrf } from "../embed/hybrid.js";

export interface SemanticFindArgs {
  query: string;
  limit?: number;
  kind?: "Function" | "Class" | "Interface" | "Enum";
  federated?: boolean;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * Factory for the semantic_find handler.
 *
 * @param store         The graph store.
 * @param repoId        The active repo id.
 * @param repoPath      File system path to the repo root (for the embedding cache).
 * @param providerOverride  Inject a provider directly (for tests — avoids env/network).
 *                          Pass null to force pure-lexical. Pass undefined to use env config.
 */
export function makeSemanticFind(
  store: GraphStore,
  repoId: string,
  repoPath = ".",
  providerOverride?: EmbeddingProvider | null,
) {
  return async (args: SemanticFindArgs): Promise<ToolResult> => {
    const { query, kind, federated } = args;
    const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

    if (!query || !query.trim()) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "query must be a non-empty string" }) }],
        isError: true,
      };
    }

    try {
      const repoIds = federated ? await federationIds(store, repoId) : [repoId];

      // Fetch the corpus from the store (both backends return nodes sorted by id)
      let corpus = await store.searchCorpus(repoIds);

      // Apply optional kind filter before ranking (design §4)
      if (kind) {
        corpus = corpus.filter((n) => n.kind === kind);
      }

      // Always compute lexical ranking first (deterministic, always-reachable baseline)
      const lexicalRanked = rankCorpus(corpus, query, MAX_LIMIT * 5);

      // Resolve provider: override for tests, env config for production
      const provider: EmbeddingProvider | null =
        providerOverride !== undefined
          ? providerOverride
          : await providerFromEnv();

      let ranking: "lexical" | "hybrid" = "lexical";
      let providerModelId: string | null = null;
      let fusedIds: string[] | null = null;

      if (provider !== null) {
        // Attempt hybrid embedding path — catch all errors → fallback to lexical
        try {
          const corpusVecs = await embedCorpus(provider, repoPath, corpus);
          const queryVecs = await provider.embed([query], "query");
          const queryVec = queryVecs[0];

          if (queryVec && corpusVecs.size > 0) {
            const cosineRanked = cosineRank(queryVec, corpusVecs);

            // Build RankedItem arrays for RRF
            const lexicalItems = lexicalRanked.map((r) => ({ id: r.node.id, score: r.score }));
            const cosineItems = cosineRanked;

            const fused = rrf(lexicalItems, cosineItems);
            fusedIds = fused.map((r) => r.id);
            ranking = "hybrid";
            providerModelId = provider.modelId();
          }
        } catch (e) {
          // Any embedding error → fall back to lexical silently (log to stderr)
          process.stderr.write(
            `[semantic_find] embedding error, falling back to lexical: ${(e as Error).message}\n`
          );
        }
      }

      // Build result rows
      const nodeById = new Map(corpus.map((n) => [n.id, n]));
      const lexicalById = new Map(lexicalRanked.map((r) => [r.node.id, r]));

      let rankedIds: string[];
      if (ranking === "hybrid" && fusedIds !== null) {
        rankedIds = fusedIds.slice(0, limit);
      } else {
        rankedIds = lexicalRanked.slice(0, limit).map((r) => r.node.id);
      }

      const results = rankedIds.map((id) => {
        const node = nodeById.get(id);
        if (!node) return null;
        const lexical = lexicalById.get(id);
        const result: Record<string, unknown> = {
          node_id: node.id,
          qualified_name: node.qualified_name,
          file_path: node.file_path,
          kind: node.kind,
          repo_id: node.repo_id,
          score: lexical?.score ?? 0,
          matched: lexical?.matched ?? [],
        };
        // Include summary only when present (keeps payload lean; absence is informative)
        if (node.summary) {
          result["summary"] = node.summary;
        }
        return result;
      }).filter(Boolean);

      const response: Record<string, unknown> = { results };
      // Disclose ranking mode (design §4 output shape)
      if (ranking === "hybrid") {
        response["ranking"] = "hybrid";
        response["provider"] = providerModelId;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(response) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
  };
}
