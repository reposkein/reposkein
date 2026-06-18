# mcp/

`@reposkein/mcp` — TypeScript MCP server + CLI. Dual entry: stdio MCP host AND `init`/`index`/`doctor`/`view` dispatcher.

## STRUCTURE

```
src/
  index.ts        # ENTRY: server bootstrap + CLI dispatch (:58 main, :251 CLI)
  cli/            # init, doctor, view (subcommand impls)
  tools/          # MCP tool factories: getContextProfile, semanticFind, impact, readCypher,
                  # writeSemanticSummary, indexerTools (initCpgSkeleton + reindexFile), temporalContext
  store/          # GraphStore abstraction + backends (see store/AGENTS.md)
  profile/        # resolve targets → assemble caller/callee neighborhood → inline prose
  search/         # bm25f.ts — deterministic lexical ranking (the default for semantic_find)
  embed/          # optional hybrid tier: cache + provider switch + RRF fusion
  embed/providers # voyage.ts (API), http.ts (Ollama / embed-server / any OpenAI-compatible)
  guard/          # caps (row/byte limits), readonly (Cypher write rejection), summaryValidation
  indexer/        # fetchBinary.ts (per-version GH Release fetch) + runIndexer.ts (spawn)
  temporal/       # gitlog.ts + temporal.ts — co-change, churn, ownership
test/             # 38 files. *.test.ts unit; *.int.test.ts integration (NEO4J_PASSWORD-gated)
bench/            # see bench/AGENTS.md
scripts/          # bundle-skill.mjs, bundle-viz.mjs, chmod-bin.mjs, postinstall.mjs
```

## CONVENTIONS

- **Factory style.** `makeReadCypher(store, repoId)` returns the bound handler. Never instantiate a class.
- **Tagged unions for results.** `{ kind: "found" | "candidates" | "not_found" }`. No exceptions for control flow.
- **`vitest.config.ts: fileParallelism: false`** — Neo4j integration tests share one DB; the shared `setupFixture()` graph (repo id `proftest`) races otherwise.
- **Mocks are handwritten stubs**, not `vi.mock`: see `test/fakeStore.ts` (every unimplemented method throws) and `MockProvider` in `test/semanticFind.test.ts`.
- **`tsconfig.json`**: `strict + noUncheckedIndexedAccess + NodeNext module/moduleResolution`. ESM only — `"type": "module"`.
- **Read-only Cypher guard**: `src/guard/readonly.ts` strips comments + literals, then deny-lists `CREATE/SET/DELETE/MERGE/REMOVE` + procedure calls.
- **Fail-soft I/O.** Sidecar cache writes are best-effort. View API returns 404 / `{}` instead of 5xx. Embeddings silently fall back to lexical on any error.
- **`UnconfiguredStore`** returns instructive error messages instead of throwing — the user sees what env var to set.

## BUILD

```
npm run build         # tsc → dist/ + chmod-bin.mjs (preserves +x on dist/index.js)
npm run prepare       # build + bundle-skill.mjs + bundle-viz.mjs (REQUIRED before publish)
npm run typecheck
npm test              # vitest (sequential file mode)
```

`prepare` bundles `../viz/dist` into `dist/viz/` and the `reposkein-graph-rag` skill into `dist/skill/`. **`dist/viz/` is part of the npm tarball** — the `view` command serves from it.

## ANTI-PATTERNS

- `vi.mock("../src/store/...")` instead of `fakeStore({ ... overrides ... })`.
- New file in `test/` named `*.test.ts` when it needs Neo4j → must be `*.int.test.ts` and gated.
- CommonJS `require()` anywhere. Pure ESM.
- Long-running state in a `make*` factory closure (handlers must be re-entrant; each MCP call is independent).
- Writing to `.reposkein/*.jsonl` directly. Only `writeSemanticSummary` mutates the graph, and it does so by spawning the indexer's 3-way merge.
- Touching `binary-digests.json` by hand — it's part of the release pipeline.
