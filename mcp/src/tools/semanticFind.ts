/**
 * semantic_find tool — deterministic lexical (BM25F) entry-point discovery.
 *
 * Cold-start seed finder: answers "where is X?" when the agent has no node_id
 * or exact identifier. Returns ranked node_ids ready for get_context_profile.
 *
 * Architecture: calls store.searchCorpus to load the eligible node set, then
 * the shared BM25F scorer ranks in TypeScript — byte-identical for both JSONL
 * and Neo4j backends. No embeddings, no external index.
 */

import type { GraphStore } from "../store/GraphStore.js";
import { federationIds } from "../store/federation.js";
import { rankCorpus } from "../search/bm25f.js";
import type { ToolResult } from "./readCypher.js";

export interface SemanticFindArgs {
  query: string;
  limit?: number;
  kind?: "Function" | "Class" | "Interface" | "Enum";
  federated?: boolean;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export function makeSemanticFind(store: GraphStore, repoId: string) {
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

      // Rank with the shared deterministic BM25F scorer
      const ranked = rankCorpus(corpus, query, limit);

      const results = ranked.map((r) => {
        const result: Record<string, unknown> = {
          node_id: r.node.id,
          qualified_name: r.node.qualified_name,
          file_path: r.node.file_path,
          kind: r.node.kind,
          repo_id: r.node.repo_id,
          score: r.score,
          matched: r.matched,
        };
        // Include summary only when present (keeps payload lean; absence is informative)
        if (r.node.summary) {
          result["summary"] = r.node.summary;
        }
        return result;
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ results }) }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
  };
}
