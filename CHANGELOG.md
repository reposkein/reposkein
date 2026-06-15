# Changelog

All notable changes to RepoSkein. Format roughly follows
[Keep a Changelog](https://keepachangelog.com); generated/maintained from
[Conventional Commits](https://www.conventionalcommits.org) (see `cliff.toml`).

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
