# Changelog

All notable changes to RepoSkein. Format roughly follows
[Keep a Changelog](https://keepachangelog.com); generated/maintained from
[Conventional Commits](https://www.conventionalcommits.org) (see `cliff.toml`).

## [Unreleased]

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
