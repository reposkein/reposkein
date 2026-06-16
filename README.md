# RepoSkein

**Give your AI coding agent a map of your codebase — instead of letting it grep and guess.**

[![npm](https://img.shields.io/npm/v/@reposkein/mcp.svg?logo=npm)](https://www.npmjs.com/package/@reposkein/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@reposkein/mcp.svg)](https://www.npmjs.com/package/@reposkein/mcp)
[![CI](https://github.com/reposkein/reposkein/actions/workflows/ci.yml/badge.svg)](https://github.com/reposkein/reposkein/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/reposkein/reposkein.svg?logo=github)](https://github.com/reposkein/reposkein/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed.svg)](https://modelcontextprotocol.io)
[![skills.sh](https://skills.sh/b/reposkein/reposkein)](https://skills.sh/reposkein/reposkein)
[![Glama](https://glama.ai/mcp/servers/reposkein/reposkein/badges/score.svg)](https://glama.ai/mcp/servers/reposkein/reposkein)
[![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-1f6feb.svg)](https://mcpservers.org/servers/reposkein/reposkein)

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

## Working with your agent

Once RepoSkein is wired in, your agent navigates the graph instead of grepping. The natural loop — you just ask in plain language, the bundled skill drives the tools:

1. **Find where to start** — `semantic_find("jwt auth validation")` ranks the right functions/classes by meaning, so the agent doesn't need to know the symbol name. *("where's the rate limiter?")*
2. **Understand it** — `get_context_profile` returns the resolved node's callers + callees as ready-to-read prose. `hops: 2` widens the neighborhood; `federated: true` spans nested repos.
3. **Before you change it** — `impact` lists the transitive callers (what could break) split from the tests that cover it (what to run). *("what breaks if I change `charge()`?")*
4. **What moves with it** — `get_temporal_context` surfaces files that historically change together (co-change), plus churn and ownership. *("what usually changes with the auth config?")*
5. **Record what you learned** — `write_semantic_summary` attaches a 1–3 sentence note to the node, committed to git so the next agent and your teammates start ahead.
6. **After editing** — `reindex_file` refreshes the graph for the file you changed.

You rarely call these by hand — the **`reposkein-graph-rag` skill** teaches your agent *when* to use each. See [Agent skills](#agent-skills-skillssh).

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
 @reposkein/mcp        semantic_find · get_context_profile · impact · get_temporal_context
   (TypeScript)        read_cypher · write_semantic_summary · init_cpg_skeleton · reindex_file
                       CLI: init · doctor
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
| `semantic_find` | find where to start — rank functions/classes by meaning (lexical BM25F; optional pluggable embeddings), seeding `get_context_profile` |
| `impact` | transitive callers of a function/class — split into impacted code vs covering tests — with counts and truncated flag |
| `read_cypher` | read-only graph queries (writes rejected, results capped) |
| `write_semantic_summary` | attach a hash-stamped summary to a node |
| `init_cpg_skeleton` | build/rebuild the graph |
| `reindex_file` | refresh after editing a file |
| `get_temporal_context` | git-derived signals for a file: change frequency, top authors, and co-change — which files historically change together (advisory, not committed) |

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

## Optional: semantic embeddings for `semantic_find`

By default, `semantic_find` is **deterministic and lexical** (BM25F — zero-infra, no keys). You can opt into a **hybrid** tier (lexical + embedding cosine, fused via RRF) for fuzzier/conceptual queries. It's **default-off**; vectors are cached in `.reposkein/local/embeddings/` (gitignored, never committed); and on any embedding error `semantic_find` falls back to lexical automatically. Set the env vars on the MCP server, restart your agent, and **pick one** of three setups:

### A) Voyage AI — cloud, easiest, best code retrieval

[Get an API key](https://dashboard.voyageai.com/), then:

```sh
REPOSKEIN_EMBED_PROVIDER=voyage
VOYAGE_API_KEY=pa-...
# optional: REPOSKEIN_EMBED_MODEL=voyage-code-3   # default — code-specialized
# optional: REPOSKEIN_EMBED_DIMS=1024             # default; 256|512|1024|2048
```

> **Privacy:** this sends the document strings (qualified names, signatures, summaries) to Voyage's API. If you have code-egress restrictions, use a local option below.

### B) Ollama — local, easiest off-the-shelf, no key

[Ollama](https://ollama.com) exposes an OpenAI-compatible endpoint and runs ready-made embedding models:

```sh
ollama pull nomic-embed-text     # 768-dim; or mxbai-embed-large (1024), bge-m3 (1024)
```
```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:11434/v1/embeddings
REPOSKEIN_EMBED_MODEL=nomic-embed-text
REPOSKEIN_EMBED_DIMS=768          # must match the model's output dims
```

### C) Voyage's open model, self-hosted — offline + Voyage quality

`voyage-4-nano` (Apache-2.0) is a custom Qwen3-based model Ollama can't run, so RepoSkein ships a **one-command server** for it in [`embed-server/`](embed-server/):

```sh
docker compose up -d                        # from the repo root — or: cd embed-server && docker compose up -d
```
```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:8080/v1/embeddings
REPOSKEIN_EMBED_MODEL=voyage-4-nano
REPOSKEIN_EMBED_DIMS=1024         # must equal EMBED_DIMS in the compose file
```

Everything stays on your machine. The image is **CPU-only and multi-arch** — it runs with **no NVIDIA GPU** on Apple Silicon / ARM unified-memory, x64 Linux, and Windows (CI builds + smoke-tests both amd64 and arm64). Docker can't use Apple's Metal/MPS — for that, run the server natively with `EMBED_DEVICE=mps` (see [`embed-server/README.md`](embed-server/README.md)). The root [`docker-compose.yml`](docker-compose.yml) also starts the optional Neo4j backend via `--profile neo4j`.

> `REPOSKEIN_EMBED_DIMS` on the client **must match** the model's actual output dimension, or cosine scoring is skipped.

---

## Agent skills (skills.sh)

RepoSkein ships two cross-agent [Agent Skills](https://skills.sh) — install into Claude Code, Cursor, Codex, and 70+ agents with one command:

```sh
npx skills add reposkein/reposkein --all
```

- **`reposkein-setup`** — installs RepoSkein in a repo and **verifies it's running** (binary → `.reposkein/` index → MCP reachability). Ask your agent to run it and it does the whole setup for you.
- **`reposkein-graph-rag`** — teaches your agent *when* to use each tool (the [loop above](#working-with-your-agent)): `semantic_find` to start, `get_context_profile` / `impact` / `get_temporal_context` to navigate, `write_semantic_summary` to record understanding. `reposkein-mcp init` installs this skill automatically; the command above also adds it to non-Claude agents.

The skills are *procedural knowledge* — the runtime is the `@reposkein/mcp` package. See [`skills/`](skills/).

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
embed-server/ one-command local embedding server (voyage-4-nano) for the optional hybrid semantic_find
```

## License

[Apache-2.0](./LICENSE).
