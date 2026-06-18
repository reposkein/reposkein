# mcp/src/store/

The `GraphStore` abstraction. Every MCP tool reads through this interface; backends are swappable at runtime via `REPOSKEIN_STORE`.

## FILES

| File | Role |
|---|---|
| `GraphStore.ts` | The interface contract. **Source of truth for row shapes.** |
| `JsonlGraphStore.ts` | Reads committed `.reposkein/*.jsonl` into memory. **Default** when `nodes.jsonl` exists. |
| `Neo4jGraphStore.ts` | Optional Cypher backend (via `neo4j-driver`). Used for very large graphs. |
| `UnconfiguredStore.ts` | Every method returns an instructive error. Selected when no backend is reachable. |
| `federation.ts` | Discovers nested `.reposkein/` dirs → derives `FEDERATES_TO` + cross-repo edges at load. |
| `jsonlGraph.ts` | In-memory graph reader (used by `JsonlGraphStore` + Track 1 bench). |
| `repoId.ts` | Maps `REPOSKEIN_REPO_PATH` → stable `repo_id`. |
| `sidecar.ts` | Best-effort writer for `.reposkein/local/` caches (BM25F, embeddings). |

## BACKEND SELECTION (`mcp/src/index.ts:buildStore`)

```
REPOSKEIN_STORE = auto (default) | jsonl | neo4j
  auto  : JSONL if nodes.jsonl exists, else Neo4j if NEO4J_PASSWORD set, else Unconfigured
  jsonl : JSONL if available, else Unconfigured
  neo4j : Neo4j if NEO4J_* env set, else Unconfigured
```

## CONVENTIONS

- **Every backend MUST pass `test/storeConformance.ts`** — the canonical parity fixture. Add a method → add a conformance case.
- **No backend may mutate `.reposkein/*.jsonl` directly.** Only `writeSemanticSummary` writes, and only via the indexer's 3-way merge.
- Federation is **load-time only** — `FEDERATES_TO` + cross-repo edges are NEVER committed (they live in `.reposkein/local/`).
- `repoId.ts` resolution is `path → blake3(canonical_path)` — keep stable for sidecar invariance.

## ANTI-PATTERNS

- Adding a method to `GraphStore` without a `storeConformance` case → backends drift silently.
- Throwing from `UnconfiguredStore` instead of returning an instructive error tuple.
- A query on Neo4j without `n.repo_id = $repo_id` (or `IN $repo_ids` for federated) — leaks results across repos.
- Caching in `.reposkein/` instead of `.reposkein/local/` — the cache would ship to git.
