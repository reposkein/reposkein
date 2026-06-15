# RepoSkein

**Give your AI coding agent a map of your codebase — instead of letting it grep and guess.**

[![npm](https://img.shields.io/npm/v/@reposkein/mcp.svg?logo=npm)](https://www.npmjs.com/package/@reposkein/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@reposkein/mcp.svg)](https://www.npmjs.com/package/@reposkein/mcp)
[![CI](https://github.com/reposkein/reposkein/actions/workflows/ci.yml/badge.svg)](https://github.com/reposkein/reposkein/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/reposkein/reposkein.svg?logo=github)](https://github.com/reposkein/reposkein/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed.svg)](https://modelcontextprotocol.io)

RepoSkein builds a deterministic **graph of your code** — files, classes, functions, imports, and call edges — with [Tree-sitter](https://tree-sitter.github.io/), and serves it to any MCP-capable agent (Claude Code, Cursor, Codex, …). Your agent navigates structure instead of guessing, then writes short summaries onto the graph as it learns — and those summaries are versioned in git, so understanding becomes **shared team memory**.

- ⚡ **Zero-infra** — no database, no Docker. The graph lives in committed `.reposkein/*.jsonl` files.
- 🔒 **Deterministic** — same code → byte-identical graph. No LLM in the construction path.
- 🌐 **7 languages** — Python, TypeScript, JavaScript, Rust, Go, Java, C#.
- 🧩 **Local-first & git-native** — the graph and its summaries travel with your code.

---

## Get started (≈30 seconds)

In the repo you want your agent to understand:

```sh
npx @reposkein/mcp init
```

That downloads the indexer, sets up git hooks, installs the agent skill, and prints an MCP config block. **Paste that block into your agent** (e.g. Claude Code's `.mcp.json`):

```jsonc
{
  "mcpServers": {
    "reposkein": {
      "command": "reposkein-mcp",
      "env": { "REPOSKEIN_REPO_PATH": "/path/to/your/repo" }
    }
  }
}
```

Build the graph and commit it:

```sh
reposkein-indexer index .      # writes .reposkein/
reposkein-mcp doctor .         # ✓ binary  ✓ indexed (N nodes)  ✓ ready
git add .reposkein && git commit -m "add RepoSkein code graph"
```

That's it. Ask your agent *"what calls this function?"* or *"what breaks if I change X?"* and it answers from the graph.

> **Prefer your agent to do the setup?** Install the skills and let it drive:
> ```sh
> npx skills add reposkein/reposkein --all
> ```
> Then tell your agent to **run the `reposkein-setup` skill** — it installs, indexes, and verifies everything for you. Works across Claude Code, Cursor, Codex, and 70+ agents.

**Platforms:** prebuilt binaries for macOS (Apple Silicon), Linux (x64/arm64), and Windows (x64). Elsewhere, point `REPOSKEIN_INDEXER_BIN` at a [from-source](#build-from-source) build.

---

## Why RepoSkein

Agents waste their context window grepping files and guessing how code connects. RepoSkein answers structural questions directly:

| Ask | RepoSkein gives the agent |
| --- | --- |
| "Who calls `charge()`?" | the exact callers, with one-line summaries |
| "What does this change impact?" | the caller/callee neighborhood, not 20 files of grep hits |
| "Where's this defined?" | the precise node — no false positives from comments or strings |

In a deterministic, no-LLM [benchmark](mcp/bench/), RepoSkein surfaces the right functions with a **mean ~8.4× fewer context tokens** than a grep-based agent on structural queries.

---

## Supported languages

| Language | Definitions | Imports | Calls |
| --- | --- | --- | --- |
| Python | classes, functions (decorators, nested) | ✅ (aliased) | ✅ |
| TypeScript / TSX | classes, interfaces, enums | ✅ (aliased) | ✅ |
| JavaScript / JSX | ✅ | ✅ | ✅ |
| Rust | structs, traits, enums, `impl` methods | ✅ `use` (groups, aliases, globs, `pub use` re-exports; workspace-aware) | ✅ |
| Go | funcs, methods (`Type.method`), structs, interfaces | intra-package; cross-package planned | ✅ |
| Java | classes, interfaces, enums, methods, constructors | ✅ package-path | ✅ |
| C# | classes, interfaces, structs, records, enums, methods, properties | intra-dir; cross-namespace planned | ✅ |

Every call edge is labeled with how it was resolved (`exact` / `name_match` / `ambiguous`) and a confidence, so the agent knows what to trust. Adding a language is a small, well-trodden path — contributions welcome.

---

## How it works

```
 Your agent (Claude Code / Cursor / …)   ── guided by the reposkein skill
        │  MCP
        ▼
 @reposkein/mcp        get_context_profile · read_cypher · write_semantic_summary
   (TypeScript)        init_cpg_skeleton · reindex_file   |   CLI: init · doctor
        │ reads
        ▼
 .reposkein/*.jsonl   ← the code graph, committed to git (zero-infra, in-memory store)
        ▲ writes
        │
 reposkein-indexer    Tree-sitter parse → stable IDs → canonical JSONL
   (Rust)             + git hooks & a 3-way merge driver for conflict-free summaries
```

- **Structure is static.** The skeleton comes only from parsing — identical code produces a byte-identical graph (a CI-tested invariant), independent of who runs it.
- **Meaning is just-in-time.** Your agent writes 1–3 sentence summaries onto nodes as it visits them; they're stamped with a content hash (so they go stale when code changes) and committed to git.
- **Optional Neo4j backend** for very large graphs and raw Cypher at scale — see [below](#neo4j-backend-optional). Most users never need it.

### Cross-repo federation

Got nested repositories (e.g. a monorepo of indexed repos)? RepoSkein discovers them, links them with `FEDERATES_TO`, and stitches **cross-repo call and import edges** at load time. Pass `federated: true` to the tools to traverse across repo boundaries. Federation edges are derived at load (never committed), so each repo stays independently deterministic.

---

## MCP tools

| Tool | What it does |
| --- | --- |
| `get_context_profile` | resolve a function/class → its caller/callee neighborhood as ready-to-read prose |
| `read_cypher` | read-only graph queries (writes rejected, results capped) |
| `write_semantic_summary` | attach a hash-stamped summary to a node |
| `init_cpg_skeleton` | build/rebuild the graph |
| `reindex_file` | refresh after editing a file |

The `reposkein-mcp` CLI adds **`init`** (set up a repo) and **`doctor`** (health check).

---

## Neo4j backend (optional)

The zero-infra JSONL store is the default and needs nothing extra. Neo4j is an optional projection for very large graphs and raw Cypher at scale:

```sh
cd indexer && docker compose up -d                          # neo4j on bolt://localhost:7687
NEO4J_PASSWORD=reposkeintest reposkein-indexer load .
```

Then set `REPOSKEIN_STORE=neo4j` and the `NEO4J_*` env vars on the MCP server. (`REPOSKEIN_STORE=auto`, the default, uses JSONL when present and falls back to Neo4j only if configured.)

---

## Build from source

Requirements: Rust (stable), Node 24. Docker only for the optional Neo4j backend.

```sh
# native indexer
cd indexer && cargo build --release        # → indexer/target/release/reposkein-indexer

# MCP server
cd mcp && npm install && npm run build
```

Wire it into your agent with `command: node`, `args: [".../mcp/dist/index.js"]`, and env `REPOSKEIN_REPO_PATH` + `REPOSKEIN_INDEXER_BIN`. Run the tests:

```sh
cd indexer && cargo test && cargo clippy --all-targets -- -D warnings
cd mcp && npm test
```

---

## Repository layout

```
indexer/   Rust workspace: core, lang-{python,ts,rust,go,java,csharp}, lang-common, neo4j-io, cli
mcp/       @reposkein/mcp — the TypeScript MCP server (tools + graph-store backends)
mcp/bench/ benchmarks: retrieval efficiency (Track 1) + end-task SWE-bench harness (Track 2)
skills/    reposkein-graph-rag + reposkein-setup — cross-agent skills (skills.sh)
```

## License

[Apache-2.0](./LICENSE).
