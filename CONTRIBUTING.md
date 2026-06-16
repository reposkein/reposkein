# Contributing to RepoSkein

Thanks for your interest! Bug fixes, new languages, and docs improvements are all welcome.

## Ground rules (read first)

RepoSkein has **two hard invariants** — please don't break them:

1. **Determinism.** The committed `.reposkein/*.jsonl` must be a **byte-identical** function of the working-tree source — same code → same graph, on any machine. CI enforces this (`determinism_two_runs_byte_identical`, `cache_warm_run_is_byte_identical_to_cold`, the Neo4j `load → export` round-trip). No LLMs, clocks, randomness, or HashMap-iteration-order may influence committed output. Anything derived/non-deterministic (embeddings, git history, cross-repo edges) lives **outside** the committed graph, under `.reposkein/local/` (gitignored).
2. **Zero-infra by default.** It must work with **no database and no Docker** (the in-memory JSONL store). Don't make Neo4j or any service *required*.

Also: **Conventional Commits** (`feat:`, `fix:`, `docs:`, …), and **keep CI green** (`cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings`; `npm test`).

## Dev setup

```sh
# Rust indexer
cd indexer && cargo build --release && cargo test

# TypeScript MCP server
cd mcp && npm install && npm test && npm run build
```

(Neo4j-gated tests skip without `NEO4J_PASSWORD`; that's expected.)

## Project layout

- `indexer/` — Rust workspace. `core` (graph model, deterministic serializer, resolver), `lang-*` (per-language Tree-sitter extractors), `lang-common` (shared helpers), `neo4j-io`, `cli`.
- `mcp/` — the `@reposkein/mcp` TypeScript MCP server (tools + graph-store backends).
- `viz/` — the `@reposkein/viz` constellation viewer SPA (served by `reposkein-mcp view`, bundled into the mcp package).

## Adding a new language

This is a well-trodden path — Go, Java, and C# were each added the same way. Create `indexer/crates/lang-<x>/` mirroring an existing crate (`lang-go` is a good template):

1. **Cargo wiring** — add `tree-sitter-<x>` to `[workspace.dependencies]` and the crate to workspace `members`.
2. **`lib.rs`** — implement the `Extractor` trait: `language() -> "<x>"` + `extract(ctx)` that parses with `tree_sitter_<x>::LANGUAGE` and returns `ExtractOutput` (return `default()` on parse failure — never panic).
3. **`defs.rs`** — a `Walk` emitting Function/Class/Interface/Enum/Variable nodes + `DEFINES`/heritage edges. **Read fields via `child_by_field_name`** (robust to hidden grammar rules). Build qualified names (methods = `Type.method`) and stable ids.
4. **The frozen `@arity` rule** — decide and **document it in `core/src/id.rs`**, with a `*_frozen` test asserting the edge cases. Once shipped, changing it rewrites every id and orphans summaries — so freeze it carefully.
5. **`calls.rs`** — a `classify` fn + `CallConfig` (mirror `lang-rust`/`lang-go`), with closure/lambda boundaries so calls aren't mis-attributed.
6. **`imports.rs`** *(optional)* — only if the language maps imports to file paths (like Python/Rust/Java). Otherwise emit `imports: vec![]` and lean on the resolver's same-directory rung.
7. **`classify.rs`** — map the extension(s) → `"<x>"`; extend test-file detection if needed (no false positives!).
8. **Register** the extractor in `cli/src/main.rs`'s extractor slice; **bump `EXTRACT_CACHE_SCHEMA`** in `core/src/cache.rs` (a new extractor changes output for those files).
9. **Tests** — `extraction_is_deterministic`, the frozen-arity table, defs/calls/imports coverage. The workspace determinism + round-trip gates then cover it automatically.

See `docs/` and the existing `lang-*` crates for concrete examples.

## Working on the viewer (`viz/`)

`viz/` is the [`@reposkein/viz`](viz/README.md) constellation viewer — the read-only 3D SPA behind `reposkein-mcp view`. Unlike `mcp/` (npm), it's a **pnpm** package:

```sh
cd viz && pnpm install
pnpm dev                       # Vite dev server (UI work)
pnpm build                     # → viz/dist  (tsc --noEmit + vite build)
```

`pnpm dev` covers UI work, but the full experience (graph data, source peek, open-in-editor) needs the `view` server's `/api/*` endpoints. For an end-to-end check, build, bundle, then run the real server: `mcp/scripts/bundle-viz.mjs` copies `viz/dist` into the mcp package (`mcp/dist/viz`) so `reposkein-mcp view` can serve it and it ships in the npm tarball:

```sh
pnpm build && node ../mcp/scripts/bundle-viz.mjs
cd ../mcp && reposkein-mcp view /path/to/an/indexed/repo
```

Keep the viewer's invariants intact: **read-only** (never mutate the committed JSONL), **zero-infra** (works directly over committed JSONL; the static export needs no server), and **deterministic** (the seeded layout is render-time only). The **`viz` CI job** (typecheck / build / test / lint) must stay green — run `pnpm typecheck && pnpm build && pnpm test && pnpm lint` before pushing.

## Pull requests

Fork, branch, make focused commits, ensure the gates above pass, and open a PR with a clear description. For new languages or anything touching the resolver/serializer, include the determinism test results in the PR.

By contributing you agree your work is licensed under [Apache-2.0](./LICENSE).
