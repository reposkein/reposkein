# Changelog

All notable changes to RepoSkein. Format roughly follows
[Keep a Changelog](https://keepachangelog.com); generated/maintained from
[Conventional Commits](https://www.conventionalcommits.org) (see `cliff.toml`).

## [Unreleased]

## [0.1.4] - 2026-06-16

A four-reviewer security + quality audit pass, plus a hardened cold-start.

### Security

- **Prebuilt indexer binary is now integrity-verified** — the release publishes
  `SHA256SUMS`, the npm package bundles per-platform digests, and the postinstall
  fetch verifies sha256 before executing (fail-closed; never runs a mismatched
  binary). HTTPS-only + host-allowlisted redirects, atomic temp→verify→rename, and
  `npm publish --provenance`.
- Indexer child process gets an explicit env allow-list (no secret leakage).
- `init` no longer overwrites existing user git hooks (marker-gated); the JSONL
  merge driver is registered with an absolute binary path.

### Added

- **Bulletproof cold-start:** `reposkein-mcp init` now **builds the initial graph**
  (use `--no-index` to skip), and a new **`reposkein-mcp index [path]`** subcommand
  indexes via the bundled binary (npx users no longer need `reposkein-indexer` on PATH).
- **TS/JS barrel re-exports** (`export … from`, `export *`) → IMPORTS edges.
- **In-file heritage:** Rust supertraits and TS `interface extends` → INHERITS.

### Fixed

- **Federation parity:** the zero-infra store now exposes the full transitive repo
  set (grandchildren were silently excluded from federated reads).
- **`semantic_find`** neutralizes summaries (closes an injection path).
- **C#** uses the last segment of a qualified base type (`Ns.Base` → `Base`).
- Embedding/`git log`/indexer calls are now **timeout-bounded** (no hangs; embeddings
  fall back to lexical); embedding cache rows are validated on load + filenames
  sanitized; `git log` header parsing is shape-anchored; the temporal cache is atomic
  + versioned; `impact`'s test-path classifier matches the indexer.
- TS base type-args stripped (`extends Foo<T>` resolves); Python Variable ids deduped.

### Hardened

- `embed-server` image runs as non-root and binds `127.0.0.1` by default.
- A permanent guard test protects the `serde_json` sorted-keys determinism assumption.

## [0.1.3] - 2026-06-16

### Docs & packaging

- Restructured the README (introduction, table of contents, prerequisites,
  usage/demo, documentation index, contributing, acknowledgements, contact) with
  an animated brand header; added `CONTRIBUTING.md` (incl. the add-a-language recipe).
- Brand-consistent headers + navigation across all READMEs.
- Enriched the npm package metadata (keywords, homepage, repository, bugs) for a
  nicer npmjs.com page + search discoverability.
- Published the `embed-server` image to GHCR (public, multi-arch amd64/arm64) and
  documented the pull-don't-build path.

## [0.1.2] - 2026-06-16

### Added

- **`semantic_find`** — find where to start: rank functions/classes by a
  deterministic lexical BM25F score over qualified names, signatures, and
  summaries; seeds `get_context_profile`. Optional **pluggable embeddings** tier
  (default off) — `voyage` (`voyage-code-3` API), `http` (local/open model, e.g.
  `voyage-4-nano`), hybrid via Reciprocal Rank Fusion; vectors cached
  non-committed in `.reposkein/local/`, automatic fallback to lexical.
- **`get_temporal_context`** — git-derived co-change (files that change
  together), churn/recency, and ownership for a file. Derived, advisory, never
  committed.
- **`impact`** — transitive callers of a function/class, split into impacted
  code vs covering tests, in one call.

## [0.1.1] - 2026-06-15

### Added

- **Go, Java, and C# language support** — now 7 languages (Python, TS/JS, Rust,
  Go, Java, C#).
- **`reposkein-mcp doctor`** — host-agnostic health check (binary, index, repo id).
- **Rust `use`→`IMPORTS`** incl. groups, aliases, globs, and `pub use` re-export
  chains; workspace-aware crate-root detection.
- **Scope-aware resolver rung** — prefers same-directory candidates before
  repo-wide name matches, reducing false-ambiguous fan-out.
- npm package README; a `Dockerfile` for MCP-registry introspection (Glama);
  cross-agent skills via skills.sh.

### Changed

- Release binaries are **Apple-Silicon-only on macOS** (4 platforms:
  darwin-arm64, linux-x64/arm64, win32-x64) — Intel macOS dropped.
- GitHub Actions bumped to Node 24 (`actions/*@v5`).

### Fixed

- TS Interface/Enum id collision (silent dedup data loss) → `unique()` +
  `content_hash`.
- `role_for` substring match (`contest_*.py` mis-flagged as a test) →
  path-segment matching.
- One unreadable file aborted the whole index → skip with a warning.
- Resolver downgraded `exact` edges via last-write-wins → keep the
  best (highest-confidence) resolution per `(caller, target)` pair.

## [0.1.0] - 2026-06-15

First public release: a local-first, deterministic GraphRAG-over-code tool — a
Rust indexer (Tree-sitter → canonical JSONL → Neo4j *or* zero-infra in-memory
store) serving an LLM agent over MCP.

### Features

- **Deterministic indexer.** Tree-sitter parses Python, TypeScript/TSX,
  JavaScript/JSX, and Rust into a Code Property Graph emitted as byte-identical
  canonical JSONL (stable `rs1:` ids, BLAKE3 content hashes, sorted keys).
- **Two interchangeable backends.** Load into Neo4j, or run fully **zero-infra**
  over an in-memory `JsonlGraphStore` — at verified behavioral parity.
- **MCP server (`@reposkein/mcp`)** with five tools: `get_context_profile`
  (caller/callee neighborhood + inlined prose), `read_cypher` (read-only,
  guarded), `write_semantic_summary` (JIT, hash-stamped for staleness),
  `init_cpg_skeleton`, `reindex_file`.
- **Federation.** Nested repos via `FEDERATES_TO`; federated `read_cypher` and
  `get_context_profile`; **cross-repo CALLS** (import-scoped, precise) and
  **cross-repo IMPORTS** edges — on both backends.
- **Incremental reindex.** Per-file extract cache (cold-vs-warm byte-identical);
  cache-accelerated `index`/`reindex`.
- **Summaries reach git.** Agent-written summaries persist via a durable sidecar
  and graft into committed JSONL (hash-validated; stale dropped).
- **Git-native sync.** A 3-way JSONL merge driver + installed git hooks keep the
  graph in lockstep with source across branches and merges.
- **Distribution.** `npx @reposkein/mcp init` installs the prebuilt indexer
  binary (postinstall fetch), git hooks + merge driver, and the navigation
  skill, then prints the MCP config. Release pipeline builds binaries for
  darwin-arm64, linux-x64/arm64, and win32-x64 (Apple Silicon only on macOS).

### Security & determinism

- Read-only Cypher guard (default-deny procedures); summaries neutralized on the
  read path (prompt-injection bound); federation `root_path` traversal guard;
  concurrent-`load` schema-creation race tolerated.
- `load → export` byte-identical round-trip; cross-repo edges are DB-only/
  in-memory so they never perturb committed output.

[0.1.0]: https://github.com/reposkein/reposkein/releases/tag/v0.1.0
