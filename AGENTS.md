# REPOSKEIN KNOWLEDGE BASE

**Generated:** 2026-06-18 · **Commit:** ead6cb1 · **Branch:** main

## OVERVIEW

Deterministic code-property graph (Tree-sitter) + MCP server, served to AI agents. Polyglot monorepo: **Rust** indexer → **TypeScript** MCP server → **React/three.js** viewer; optional **Python** embedding server. Apache-2.0.

## HARD INVARIANTS (CI-ENFORCED — NEVER BREAK)

1. **Determinism.** `.reposkein/*.jsonl` is a byte-identical function of source. No LLMs / clocks / randomness / `HashMap`-iteration-order in the indexer path. Gates: `determinism_two_runs_byte_identical`, `cache_warm_run_is_byte_identical_to_cold`, Neo4j `load → export` round-trip.
2. **Zero-infra by default.** Must work with no DB and no Docker. Neo4j and embed-server are OPTIONAL; never make them required.

Anything non-deterministic (embeddings, git history, cross-repo edges) lives under `.reposkein/local/` — **gitignored, never committed**.

## STRUCTURE

```
indexer/      # Rust cargo workspace (10 crates): core + lang-* + cli + neo4j-io
mcp/          # @reposkein/mcp — TS MCP server (npm). Bundles viz/dist + skill on prepare.
mcp/bench/    # Track 1 (TS retrieval, deterministic) + Track 2 (Python SWE-bench, opt-in)
viz/          # @reposkein/viz — React + R3F constellation SPA (pnpm 10.15.0)
embed-server/ # Optional FastAPI service for hybrid semantic_find (Python)
skills/       # reposkein-graph-rag + reposkein-setup (cross-agent procedural knowledge)
scripts/      # release.sh — syncs Cargo + npm versions, runs git-cliff, tags
cliff.toml    # git-cliff config (Conventional Commits → CHANGELOG.md)
```

## WHERE TO LOOK

| Task | Location |
|---|---|
| Add language extractor | `indexer/crates/lang-<x>/` (template: `lang-go`); register in `indexer/crates/cli/src/main.rs` |
| New MCP tool | `mcp/src/tools/` + register in `mcp/src/index.ts` |
| Graph storage backend | `mcp/src/store/` (GraphStore + JSONL + Neo4j + Federation) |
| Cross-file resolution semantics | `indexer/crates/core/src/resolve.rs` (2291 LOC) |
| Frozen `@arity` qualified-name rule | `indexer/crates/core/src/id.rs` (changing it orphans all summaries) |
| Viewer rendering | `viz/src/scene/` (R3F, three.js, encoding.ts = SSoT) |
| Viewer graph engine | `viz/src/data/` (model/layout/lens/tour/worker) |
| Embedding provider impl | `mcp/src/embed/providers/{voyage,http}.ts` |
| CI gates | `.github/workflows/ci.yml` (indexer + indexer-neo4j-roundtrip + version-lockstep + mcp + viz) |
| Release cut | `scripts/release.sh <version>` then `git push --follow-tags` |

## CONVENTIONS (THIS REPO ONLY)

- **Version lockstep**: `indexer/Cargo.toml [workspace.package].version` MUST equal `mcp/package.json.version`. CI fails the `version-lockstep` job on skew. The npm `postinstall` fetches `reposkein-indexer-<platform>` from the GitHub Release at that exact version.
- **Mixed package managers**: `mcp/` uses **npm** (`package-lock.json`); `viz/` uses **pnpm@10.15.0** (`pnpm-lock.yaml`). Don't cross-pollinate.
- **mcp builds viz**: `mcp prepare` runs `bundle-skill.mjs` + `bundle-viz.mjs` → `mcp/dist/viz/`. CI builds `viz/` first, then runs `node scripts/bundle-viz.mjs` in mcp before tests/publish.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `perf:`, `refactor:`); `chore:` / `style:` / `ci:` are dropped from CHANGELOG by `cliff.toml`.
- **Integration tests** named `*.int.test.ts` (mcp) or `#[ignore]` (indexer Neo4j); gated by `NEO4J_PASSWORD` env.
- **mcp test runner**: `fileParallelism: false` in `mcp/vitest.config.ts` — Neo4j and shared fixtures race otherwise.

## ANTI-PATTERNS (FORBIDDEN HERE)

- **`serde_json` feature `preserve_order`** — explicitly banned in `indexer/Cargo.toml` (would couple JSONL byte-order to insertion order; breaks determinism).
- **Making Neo4j or embed-server required.** Zero-infra invariant.
- **Adding LLMs / time / randomness / unsorted iteration to `indexer/`.** Determinism invariant.
- **Mutating committed `.reposkein/*.jsonl` from `mcp/` or `viz/`.** Viewer is read-only; mcp only writes `write_semantic_summary` via the indexer's 3-way merge driver.
- **Changing the `@arity` qualified-name rule in `core/src/id.rs`** without a `*_frozen` test diff — orphans every existing summary.
- **`docker compose` as a build dependency** — only optional services (`embed`, `neo4j` profile).

## COMMANDS

```bash
# Build from source (no Docker)
cd indexer && cargo build --release
cd ../mcp && npm install && npm run build

# Test (per workspace)
cd indexer && cargo test && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings
cd mcp && npm test                                    # set NEO4J_PASSWORD for gated *.int.test.ts
cd viz && pnpm install && pnpm typecheck && pnpm build && pnpm test && pnpm lint

# End-to-end viewer
cd viz && pnpm build && node ../mcp/scripts/bundle-viz.mjs && cd ../mcp && node dist/index.js view <indexed-repo>

# Optional services
docker compose up -d                  # embed-server (CPU)
docker compose --profile neo4j up -d  # also Neo4j

# Release
scripts/release.sh 0.2.5 && git push --follow-tags origin main
```

## NOTES

- Indexer binary is **not** in the npm tarball — `postinstall.mjs` fetches `reposkein-indexer-<platformKey>` per-version from GitHub Releases. Platform keys: `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`. **No `darwin-x64`** (Intel Macs deliberately not built).
- `mcp/src/index.ts` is a **dual entry**: stdio MCP server (via `McpServer` + `StdioServerTransport`) AND CLI dispatcher (`init`/`index`/`doctor`/`view`). Selected by argv at runtime.
- `viz/` static export uses **hash history** (`createHashHistory`) because the demo deploys to a GitHub Pages subpath where browser-history routing breaks. Local `view` server uses normal history.
- Per-workspace `AGENTS.md` files override these conventions where applicable.
