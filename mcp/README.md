# @reposkein/mcp

**Give your AI coding agent a map of your codebase — instead of letting it grep and guess.**

[![npm](https://img.shields.io/npm/v/@reposkein/mcp.svg?logo=npm)](https://www.npmjs.com/package/@reposkein/mcp)
[![npm downloads](https://img.shields.io/npm/dm/@reposkein/mcp.svg)](https://www.npmjs.com/package/@reposkein/mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/reposkein/reposkein/blob/main/LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed.svg)](https://modelcontextprotocol.io)
[![skills.sh](https://skills.sh/b/reposkein/reposkein)](https://skills.sh/reposkein/reposkein)

This is the [Model Context Protocol](https://modelcontextprotocol.io) server for [**RepoSkein**](https://github.com/reposkein/reposkein) — a deterministic **code graph** (functions, classes, imports, call edges) built from your repo with [Tree-sitter](https://tree-sitter.github.io/) and served to any MCP-capable agent (Claude Code, Cursor, Codex, …). Your agent navigates structure instead of guessing, and writes short summaries onto the graph as it learns — versioned in git as shared team memory.

- ⚡ **Zero-infra** — no database, no Docker. The graph lives in committed `.reposkein/*.jsonl` files.
- 🔒 **Deterministic** — same code → byte-identical graph. No LLM in the construction path.
- 🌐 **7 languages** — Python, TypeScript, JavaScript, Rust, Go, Java, C#.

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

Build the graph, verify, and commit it:

```sh
reposkein-indexer index .     # writes .reposkein/
reposkein-mcp doctor .        # ✓ binary  ✓ indexed (N nodes)  ✓ ready
git add .reposkein && git commit -m "add RepoSkein code graph"
```

Then ask your agent *"what calls this function?"* or *"what breaks if I change X?"* — it answers from the graph.

## Tools

| Tool | What it does |
| --- | --- |
| `get_context_profile` | resolve a function/class → its caller/callee neighborhood as ready-to-read prose |
| `read_cypher` | read-only graph queries (writes rejected, results capped) |
| `write_semantic_summary` | attach a hash-stamped summary to a node |
| `init_cpg_skeleton` | build/rebuild the graph |
| `reindex_file` | refresh after editing a file |

CLI: `reposkein-mcp init` (set up a repo) and `reposkein-mcp doctor` (health check).

## Configuration

| Env var | Purpose |
| --- | --- |
| `REPOSKEIN_REPO_PATH` | the repository the server operates on (required for repo-scoped tools) |
| `REPOSKEIN_STORE` | `auto` (default) · `jsonl` (zero-infra) · `neo4j` |
| `REPOSKEIN_INDEXER_BIN` | override the `reposkein-indexer` binary path (unsupported platforms) |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | optional Neo4j backend (large graphs / Cypher at scale) |

**Platforms:** prebuilt indexer binaries for macOS (Apple Silicon), Linux (x64/arm64), and Windows (x64).

## Learn more

Full documentation, architecture, supported-language details, benchmarks, and the cross-agent skills live in the main repository:

👉 **https://github.com/reposkein/reposkein**

## License

[Apache-2.0](https://github.com/reposkein/reposkein/blob/main/LICENSE).
