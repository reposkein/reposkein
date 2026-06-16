<div align="center">
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:070A12,45:2DD4BF,100:F2B84B&height=150&section=header&text=RepoSkein&fontColor=EAE7DC&fontSize=56&animation=fadeIn" width="100%" alt="RepoSkein" />
</div>

# @reposkein/mcp

**Give your AI coding agent a map of your codebase — instead of letting it grep and guess.**

[![npm](https://img.shields.io/npm/v/@reposkein/mcp?style=for-the-badge&logo=npm&logoColor=EAE7DC&label=npm&labelColor=070A12&color=F2B84B)](https://www.npmjs.com/package/@reposkein/mcp)
[![downloads](https://img.shields.io/npm/dm/@reposkein/mcp?style=for-the-badge&label=downloads&labelColor=070A12&color=2DD4BF)](https://www.npmjs.com/package/@reposkein/mcp)
[![License](https://img.shields.io/badge/license-Apache_2.0-F2B84B?style=for-the-badge&labelColor=070A12)](https://github.com/reposkein/reposkein/blob/main/LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-2DD4BF?style=for-the-badge&labelColor=070A12)](https://modelcontextprotocol.io)
[![skills.sh](https://skills.sh/b/reposkein/reposkein)](https://skills.sh/reposkein/reposkein)
[![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-2DD4BF?style=for-the-badge&labelColor=070A12)](https://mcpservers.org/servers/reposkein/reposkein)
[![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-1f6feb.svg)](https://mcpservers.org/servers/reposkein/reposkein)

This is the [Model Context Protocol](https://modelcontextprotocol.io) server for [**RepoSkein**](https://github.com/reposkein/reposkein) — a deterministic **code graph** (functions, classes, imports, call edges) built from your repo with [Tree-sitter](https://tree-sitter.github.io/) and served to any MCP-capable agent (Claude Code, Cursor, Codex, …). Your agent navigates structure instead of guessing, and writes short summaries onto the graph as it learns — versioned in git as shared team memory.

- ⚡ **Zero-infra** — no database, no Docker. The graph lives in committed `.reposkein/*.jsonl` files.
- 🔒 **Deterministic** — same code → byte-identical graph. No LLM in the construction path.
- 🌐 **7 languages** — Python, TypeScript, JavaScript, Rust, Go, Java, C#.

**Contents:** [Get started](#get-started-30-seconds) · [Tools](#tools) · [How your agent uses it](#how-your-agent-uses-it) · [Configuration](#configuration) · [Embeddings](#optional-semantic-embeddings) · [Learn more](#learn-more)

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

`init` already built the graph — verify and commit it:

```sh
reposkein-mcp doctor .        # ✓ binary  ✓ indexed (N nodes)  ✓ ready
git add .reposkein && git commit -m "add RepoSkein code graph"
# re-index after big changes:  reposkein-mcp index .
```

Then ask your agent *"what calls this function?"* or *"what breaks if I change X?"* — it answers from the graph.

## Tools

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

**CLI:**

- `reposkein-mcp init` — set up a repo (downloads the indexer, installs git hooks + the skill, builds the graph, prints an MCP config block).
- `reposkein-mcp doctor` — health check (binary → index → MCP reachability).
- `reposkein-mcp index` — rebuild the committed graph after big changes.
- `reposkein-mcp view [path]` — open the **constellation viewer**: a local, read-only, zero-infra web app (bound to `127.0.0.1`) that renders the committed `.reposkein` graph as an interactive 3D astronomy-style map. `--export <dir>` instead writes a self-contained static site (works from `file://` or any static host). See the [viewer section in the main README](https://github.com/reposkein/reposkein#visualize-the-graph--the-constellation-viewer), or **[try the live demo](https://reposkein.github.io/reposkein/)** (RepoSkein viewing its own graph).

## How your agent uses it

You ask in plain language; the bundled skill drives the tools:

1. **`semantic_find`** — find where to start by meaning (*"where's the rate limiter?"*).
2. **`get_context_profile`** — callers + callees of a function/class as ready-to-read prose.
3. **`impact`** — before editing: transitive callers (what breaks) + the tests that cover it.
4. **`get_temporal_context`** — files that historically change together, plus churn/ownership.
5. **`write_semantic_summary`** — record understanding onto the node (committed to git).
6. **`reindex_file`** — refresh after an edit.

Install the cross-agent skills so your agent knows when to use each:

```sh
npx skills add reposkein/reposkein --all
```

(`reposkein-mcp init` already installs the navigation skill for Claude Code; this adds it to Cursor, Codex, and 70+ other agents.)

## Configuration

| Env var | Purpose |
| --- | --- |
| `REPOSKEIN_REPO_PATH` | the repository the server operates on (required for repo-scoped tools) |
| `REPOSKEIN_STORE` | `auto` (default) · `jsonl` (zero-infra) · `neo4j` |
| `REPOSKEIN_INDEXER_BIN` | override the `reposkein-indexer` binary path (unsupported platforms) |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | optional Neo4j backend (large graphs / Cypher at scale) |
| `REPOSKEIN_EMBED_PROVIDER` | `none` (default) · `voyage` · `http` — see below |
| `REPOSKEIN_EMBED_MODEL` | embedding model id (provider default when absent) |
| `REPOSKEIN_EMBED_DIMS` | output dimension (model default when absent) |
| `VOYAGE_API_KEY` | API key for the `voyage` provider |
| `REPOSKEIN_EMBED_URL` | base URL for the `http` (local model) provider |

### Optional: semantic embeddings

By default, `semantic_find` is **deterministic and lexical** (BM25F over qualified names, signatures, and summaries) — zero-infra, no API keys, byte-identical results. You can optionally enable a **hybrid embedding tier** that fuses lexical + cosine similarity via Reciprocal Rank Fusion (RRF):

**Voyage API (cloud):**

```sh
REPOSKEIN_EMBED_PROVIDER=voyage
VOYAGE_API_KEY=<your-key>
# Optional: REPOSKEIN_EMBED_MODEL=voyage-code-3 (default)
# Optional: REPOSKEIN_EMBED_DIMS=1024  (default; Matryoshka: 256/512/1024/2048)
```

> **Privacy note:** with `REPOSKEIN_EMBED_PROVIDER=voyage`, the document strings (qualified names, signatures, agent-written summaries) are sent to Voyage AI's servers for embedding. Teams with code-egress restrictions should use the local/http provider or leave embeddings disabled.

**Local/offline model (no egress):**

```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:8080/v1/embeddings
REPOSKEIN_EMBED_MODEL=voyage-4-nano   # or any model your local server serves
REPOSKEIN_EMBED_DIMS=1024
```

Point this at any OpenAI-compatible local embedding server. Two easy options: **Ollama** (`ollama pull nomic-embed-text`, URL `http://127.0.0.1:11434/v1/embeddings`, dims 768), or RepoSkein's **one-command `voyage-4-nano` server** — [`embed-server/`](https://github.com/reposkein/reposkein/tree/main/embed-server) (`docker compose up -d`). All text stays on your machine.

**How it works:** vectors are cached in `.reposkein/local/embeddings/` (gitignored — never committed, never required). The cache is invalidated per-node when the document content changes. On any embedding error, `semantic_find` silently falls back to the lexical result. Enabling embeddings never changes the committed graph.

**Platforms:** prebuilt indexer binaries for macOS (Apple Silicon), Linux (x64/arm64), and Windows (x64).

## Learn more

Full documentation, architecture, supported-language details, benchmarks, and the cross-agent skills live in the main repository:

👉 **https://github.com/reposkein/reposkein**

## License

[Apache-2.0](https://github.com/reposkein/reposkein/blob/main/LICENSE).
