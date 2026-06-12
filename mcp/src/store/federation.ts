import type { GraphStore } from "./GraphStore.js";

const TTL_MS = 30_000;
const cache = new Map<string, { ids: string[]; at: number }>();

const FED_QUERY =
  "MATCH (r:Repository {repo_id: $repo_id, root_path: '.'})-[:FEDERATES_TO*1..8]->(x:Repository) " +
  "WHERE x.federated_repo_id IS NOT NULL RETURN DISTINCT x.federated_repo_id AS id";

/** The active repo_id plus all transitively federated repo_ids (sorted, deduped).
 *  Direct children resolve via committed root→proxy edges; grandchildren via the
 *  stitch edges created at load. Cached ~30s per repo. */
export async function federationIds(store: GraphStore, repoId: string): Promise<string[]> {
  const hit = cache.get(repoId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  let ids = new Set<string>([repoId]);
  try {
    const rows = await store.runRead(FED_QUERY, { repo_id: repoId }, { timeoutMs: 5000 });
    for (const r of rows) if (typeof r.id === "string") ids.add(r.id);
  } catch {
    // Degrade to the single repo on any error (never break a read).
    ids = new Set<string>([repoId]);
  }
  const sorted = [...ids].sort();
  cache.set(repoId, { ids: sorted, at: Date.now() });
  return sorted;
}
