# viz/src/data/

"The brains." 39 files: graph model + deterministic layout + lenses + navigation + impact + temporal coupling + guided tour. Pure logic, no React.

## ROLES

| Role | Files |
|---|---|
| **Model** | `model.ts`, `clientModel.ts`, `parse.ts`, `hash.ts` |
| **Layout** | `layout.ts` (d3-force-3d), `cluster.ts` (LOD tree), `positionCache.ts` (IndexedDB) |
| **Navigation** | `navigate.ts`, `neighborhood.ts` (N-hop focus) |
| **Lenses & analytics** | `lens.ts`, `impact.ts`, `language.ts`, `classify.ts`, `federation.ts` |
| **Tour** | `tour.ts` (deterministic 5-stop flythrough: overview → modules → hub → hierarchy → entry) |
| **Data plumbing** | `api.ts` (fetch from `reposkein-mcp view` /api/*), `staticMode.ts` (window.__REPOSKEIN_GRAPH__), `worker/graph.worker.ts` (off-main-thread load+parse+layout) |
| **Perf** | `largeGraph.ts` |
| **Types** | `d3-force-3d.d.ts` (the lib has no shipped types) |
| **Fixtures** | `__fixtures__/` |

## INVARIANTS (HARD)

- **Deterministic layout.** Force seed is fixed; same graph → same map. Cached in IndexedDB via `positionCache.ts`. Layout NEVER touches the committed `.reposkein/*.jsonl`.
- **Layout in a worker.** Main thread cannot block on force iteration. Use `worker/graph.worker.ts` — never run d3-force inline.
- **Static-mode detection** is `staticMode.ts:isStaticMode()` — read `window.__REPOSKEIN_GRAPH__` BEFORE deciding whether to fetch `/api/*`.
- **Federation edges are load-time derived** (`federation.ts`). They look like normal edges but are NEVER persisted.

## CONVENTIONS

- `classify.ts` is the SSoT for test-file detection (mirrors the indexer's logic in `core/src/classify.rs`). Patterns: `*_test.*`, `test_*.py`, `*.test.ts`, `*.spec.tsx`, `FooTest.java`, `FooTests.cs`, + path segments `test`, `tests`, `__tests__`, `spec`, `specs`, `testing`. **Keep in sync with the indexer.**
- Tests colocated as `*.test.ts` (no `__tests__/`).
- Heavy comments are intentional — these algorithms are the project's secret sauce. Read before editing.

## ANTI-PATTERNS

- A non-seeded `Math.random()` in `layout.ts` — breaks "same graph → same map".
- Mutating a node's position from outside `layout.ts` — bypasses the position cache.
- Computing impact / lens / temporal-coupling overlays by re-fetching. They're **derived views** over the in-memory graph (re-color, re-filter; no I/O).
- Importing from `../scene/` or `../panels/` — `data/` is the dependency root, not a leaf.
