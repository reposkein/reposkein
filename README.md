# RepoSkein

**Thread your repo into agent-ready context.**

RepoSkein is a local-first developer tool that solves the context-window problem for LLM agents working in large or nested repositories. Instead of letting an agent grep and guess, it builds a deterministic **Code Property Graph** of your codebase — directories, files, classes, functions, imports, calls — with [Tree-sitter](https://tree-sitter.github.io/) static analysis, then lets the agent enrich that skeleton with natural-language summaries *just-in-time*. The graph is served to any MCP-capable agent (Claude Code, Cursor, Zed, …) and the agent-written summaries are versioned in git alongside the code — so semantic understanding becomes **shared team memory**.

> Status: **v1 core is complete and CI-green** — deterministic indexer, Neo4j round-trip, the five MCP tools, the git-sync merge driver + hooks, and summary persistence all work end-to-end across Python, TypeScript/TSX, JavaScript/JSX, and Rust. Packaged distribution (npm + prebuilt binaries) is in progress; after the first release `npx @reposkein/mcp init` will work out of the box. Contributors: build from source (see below).

## Install

> **Note:** `npx @reposkein/mcp` is available after the first `v*` release is published to npm. Until then, contributors use the build-from-source path below.

### After the first release (users)

```sh
# In the repository you want to index:
npx @reposkein/mcp init [path]
```

`init` will:
1. Download and cache the `reposkein-indexer` binary for your platform.
2. Install git hooks + the JSONL three-way merge driver (runs `reposkein-indexer init --hooks`).
3. Drop the navigation skill (`SKILL.md`) into `.claude/skills/reposkein-graph-rag/`.
4. Print the MCP server config to add to your client.

Add the printed config to your agent client (e.g. Claude Code `.mcp.json`):

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

Then build the graph — ask your agent to call `init_cpg_skeleton`, or run:

```sh
reposkein-indexer index /path/to/your/repo
```

Commit the generated `.reposkein/` directory so the graph and summaries are shared with your team.

### Install the agent skills (skills.sh)

RepoSkein ships cross-agent skills. To teach any compatible agent (Claude Code,
Cursor, Codex, …) how to set up and use RepoSkein:

```bash
npx skills add reposkein/reposkein --all
```

Then ask your agent to run the `reposkein-setup` skill — it installs the
`@reposkein/mcp` server, builds the graph, and verifies everything with
`reposkein-mcp doctor` + a probe tool call. See [`skills/`](skills/).

## How it works

```
 AI agent (MCP host)  ── governed by SKILL.md (reposkein-graph-rag)
        │
        ▼
 @reposkein/mcp  (TypeScript, thin)   read_cypher · get_context_profile ·
   │  read-only guard, repo scoping,  write_semantic_summary · init · reindex
   │  summary validation
   ├──▶ spawns ──▶ reposkein-indexer  (Rust)  walk · Tree-sitter parse ·
   │                stable IDs · canonical JSONL · Neo4j import/export · merge driver
   ▼
 Neo4j 5.x  (single DB, Docker)
   ▲
   │  bulk import / export
 .reposkein/nodes.jsonl + edges.jsonl   ←── versioned in git (canonical, diff-friendly)
        ▲
        │  pre-commit (export, incl. agent summaries) / post-merge (import)
      git hooks  +  three-way JSONL merge driver
```

- **Deterministic structure.** The graph skeleton comes only from static analysis — no LLM in the construction path. Identical source trees produce **byte-identical** `.reposkein/*.jsonl` (a CI-tested invariant), independent of the developer's machine.
- **Semantic flesh, just-in-time.** The agent writes 1–3-sentence summaries onto nodes only when it visits them; summaries are content-hash-stamped (so they're flagged stale when code changes) and committed to git.
- **Local-first, git-native.** Neo4j is a reconstructable projection; the canonical JSONL files are the source of truth. A git merge driver merges concurrent summaries across clones without conflicts.

## Supported languages

| Language | Definitions | Imports + Calls |
| --- | --- | --- |
| Python | ✅ (incl. decorators, `if`/`try`-nested) | ✅ |
| TypeScript / TSX | ✅ (classes, interfaces, enums) | ✅ |
| JavaScript / JSX | ✅ | ✅ |
| Rust | ✅ (structs, traits, enums, `impl` methods) | imports/calls planned |

Call edges carry an honest `resolution` (`exact` / `name_match` / `ambiguous`) and `confidence` — the skill instructs agents to verify non-exact edges.

## The graph

**Nodes:** `Repository`, `Directory`, `File`, `Class`, `Interface`, `Enum`, `Function`, `Variable`.
**Edges:** `CONTAINS`, `DEFINES`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`.
Stable IDs (`rs1:<repo>:<kind>:<path>#<qualified_name>@<arity>`) survive line-number drift so summaries persist through unrelated edits.

## MCP tools

- **`init_cpg_skeleton`** — index a repo and load it into the graph.
- **`get_context_profile`** — resolve a function/class and return its caller/callee neighborhood as pre-inlined prose + an `enrichment_needed` list (the JIT loop driver).
- **`write_semantic_summary`** — attach a hash-stamped, validated plain-text summary to a node.
- **`read_cypher`** — read-only Cypher (write clauses rejected; results capped).
- **`reindex_file`** — refresh the graph after editing a file.

### Build from source (contributors)

Prerequisites: Rust (stable), Node 24, Docker.

```sh
# 1. Build the native indexer
cd indexer && cargo build --release      # binary at indexer/target/release/reposkein-indexer

# 2. Start Neo4j
cd indexer && docker compose up -d        # neo4j on bolt://localhost:7687 (neo4j/reposkeintest)

# 3. Index a repository and load it into the graph
reposkein-indexer init --hooks /path/to/repo          # installs git hooks + merge driver
reposkein-indexer index --name myrepo /path/to/repo   # writes .reposkein/*.jsonl + meta.json
NEO4J_PASSWORD=reposkeintest reposkein-indexer load /path/to/repo

# 4. Build the MCP server
cd mcp && npm install && npm run build
```

Wire the MCP server into your agent (e.g. Claude Code `.mcp.json`):

```jsonc
{ "mcpServers": { "reposkein": {
  "command": "node",
  "args": ["/abs/path/reposkein/mcp/dist/index.js"],
  "env": {
    "NEO4J_URI": "neo4j://localhost:7687",
    "NEO4J_USER": "neo4j",
    "NEO4J_PASSWORD": "reposkeintest",
    "REPOSKEIN_REPO_ID": "<from .reposkein/meta.json>",
    "REPOSKEIN_REPO_PATH": "/path/to/repo",
    "REPOSKEIN_INDEXER_BIN": "/abs/path/reposkein/indexer/target/release/reposkein-indexer"
  } } } }
```

Then install the skills (`skills/`) so the agent navigates the graph instead of grepping.

## Repository layout

```
indexer/   Rust workspace: core · lang-python · lang-ts · lang-rust · neo4j-io · cli
mcp/        @reposkein/mcp — TypeScript MCP server (tools, GraphStore, read-only guard)
skills/     reposkein-graph-rag + reposkein-setup agent skills (skills.sh layout)
docs/       design docs
```

## Development

```sh
cd indexer && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
cd mcp && npm test          # DB-gated suites skip without NEO4J_PASSWORD
```

CI (GitHub Actions) runs the indexer test/fmt/clippy, the mcp build/test, and the Neo4j `load → export` byte-identical round-trip on every push and PR.

## License

[Apache-2.0](./LICENSE).
