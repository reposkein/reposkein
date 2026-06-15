# RepoSkein

**Thread your repo into agent-ready context.**

RepoSkein is a local-first developer tool that solves the context-window problem for LLM agents working in large or nested repositories. Instead of letting an agent grep and guess, it builds a deterministic **Code Property Graph** of your codebase — directories, files, classes, functions, imports, calls — with [Tree-sitter](https://tree-sitter.github.io/) static analysis, then lets the agent enrich that skeleton with natural-language summaries *just-in-time*. The graph is served to any MCP-capable agent (Claude Code, Cursor, Zed, …) and the agent-written summaries are versioned in git alongside the code — so semantic understanding becomes **shared team memory**.

> Status: **v0.1.0 released.** `@reposkein/mcp` is on npm and prebuilt `reposkein-indexer` binaries ship with each GitHub Release, so `npx @reposkein/mcp init` works out of the box. The v1 core is complete and CI-green: deterministic indexer, **zero-infra** in-memory graph store *and* Neo4j round-trip, the five MCP tools, cross-repo federation, the git-sync merge driver + hooks, and summary persistence — across Python, TypeScript/TSX, JavaScript/JSX, and Rust.

---

## Quick start

In the repository you want to index:

```sh
npx @reposkein/mcp init [path]
```

`init` will:
1. Download and cache the `reposkein-indexer` binary for your platform.
2. Install git hooks + the JSONL three-way merge driver (`reposkein-indexer init --hooks`).
3. Drop the navigation skill into `.claude/skills/reposkein-graph-rag/`.
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

Build the graph — ask your agent to call `init_cpg_skeleton`, or run:

```sh
reposkein-indexer index /path/to/your/repo
```

Commit the generated `.reposkein/` directory so the graph and summaries are shared with your team. Then **verify everything is wired up**:

```sh
reposkein-mcp doctor .      # ✓ indexer binary  ✓ repo indexed (N nodes)  ✓ repo id → PASS
```

`doctor` checks the prerequisites (binary present, repo indexed, repo id resolvable) and exits non-zero if any critical check fails, so you can gate on it. To confirm the server is actually reachable from your agent, ask it to call `get_context_profile` on a known function — a normal caller/callee profile means RepoSkein is live.

### Zero-infra by default (no Docker required)

The MCP server reads the **committed `.reposkein/*.jsonl`** directly from an in-memory graph store — **you do not need Neo4j or Docker** to query the graph. `REPOSKEIN_STORE=auto` (the default) uses the JSONL store when `.reposkein/nodes.jsonl` is present, and falls back to Neo4j only if you've configured it. Force a backend with `REPOSKEIN_STORE=jsonl` or `REPOSKEIN_STORE=neo4j`. Neo4j is an optional projection for very large graphs and raw Cypher at scale (see [Neo4j backend](#neo4j-backend-optional)).

### Platforms

Prebuilt binaries are published for **darwin-arm64 (Apple Silicon), linux-x64, linux-arm64, win32-x64**. Intel macOS (`darwin-x64`) is intentionally not built — all Macs ship Apple Silicon since 2020. On unsupported hosts, set `REPOSKEIN_INDEXER_BIN` to a `reposkein-indexer` you built from source.

---

## Install the agent skills (skills.sh)

RepoSkein ships two cross-agent [Agent Skills](https://skills.sh) — installable into Claude Code, Cursor, Codex, and 70+ other agents with one command:

```sh
npx skills add reposkein/reposkein --all
```

- **`reposkein-setup`** — installs RepoSkein in a repo and **verifies it's running** (binary → `.reposkein/` index → MCP server reachability via a probe tool call). Start here.
- **`reposkein-graph-rag`** — navigates the code graph (callers, callees, impact, summaries). Used once RepoSkein is set up.

The skills are *procedural knowledge* — they teach your agent how to install, verify, and drive RepoSkein. The runtime itself is the `@reposkein/mcp` npm package + the native indexer. (A skill can't register an MCP server for you — that step is host-specific, so `reposkein-setup` guides it per agent.) See [`skills/`](skills/).

---

## How it works

```
 AI agent (MCP host)  ── governed by SKILL.md (reposkein-graph-rag / reposkein-setup)
        │
        ▼
 @reposkein/mcp  (TypeScript, thin)   read_cypher · get_context_profile ·
   │  read-only guard, repo scoping,  write_semantic_summary · init_cpg_skeleton · reindex_file
   │  summary validation              + CLI: init · doctor
   │
   ├── reads ──▶ .reposkein/nodes.jsonl + edges.jsonl   (zero-infra in-memory store — DEFAULT)
   │
   └── spawns ─▶ reposkein-indexer  (Rust)  walk · Tree-sitter parse · stable IDs ·
                   canonical JSONL · Neo4j import/export · 3-way merge driver
                        │                                  ▲
                        ▼                                  │ bulk import / export (optional)
              .reposkein/*.jsonl  ←── versioned in git ──▶ Neo4j 5.x (optional, for scale/Cypher)
                        ▲
                        │  pre-commit (export, incl. agent summaries) / post-merge (import)
                      git hooks  +  three-way JSONL merge driver
```

- **Deterministic structure.** The graph skeleton comes only from static analysis — no LLM in the construction path. Identical source trees produce **byte-identical** `.reposkein/*.jsonl` (a CI-tested invariant), independent of the developer's machine. Stable IDs (`rs1:<repo>:<kind>:<path>#<qualified_name>@<arity>`) survive line-number drift so summaries persist through unrelated edits.
- **Semantic flesh, just-in-time.** The agent writes 1–3-sentence summaries onto nodes only when it visits them; summaries are content-hash-stamped (flagged stale when code changes) and committed to git.
- **Local-first, git-native.** The canonical JSONL files are the source of truth; Neo4j is a reconstructable projection. A git merge driver merges concurrent summaries across clones without conflicts.

---

## Cross-repo federation

RepoSkein understands **nested repositories**. When a repo contains other indexed repos, RepoSkein discovers them, links them with `FEDERATES_TO`, and stitches cross-repo edges at load time:

- **Cross-repo `CALLS`** — import-gated and precise: a caller's unresolved bare calls are matched against functions in the files its file actually imports from (high-confidence), with a federation-wide fallback.
- **Cross-repo `IMPORTS`** — file-to-file import edges resolved across repo boundaries.

Cross-repo edges are **never committed** (they're derived at load from each repo's own committed JSONL), so per-repo determinism holds. Pass `federated: true` to `get_context_profile` / `read_cypher` to resolve and traverse across the federation. Both backends — the zero-infra JSONL store and Neo4j — implement federation at parity.

---

## Supported languages

| Language | Definitions | Imports | Calls |
| --- | --- | --- | --- |
| Python | ✅ (incl. decorators, `if`/`try`-nested) | ✅ (incl. aliased) | ✅ |
| TypeScript / TSX | ✅ (classes, interfaces, enums, default exports) | ✅ (incl. aliased) | ✅ |
| JavaScript / JSX | ✅ | ✅ | ✅ |
| Rust | ✅ (structs, traits, enums, `impl` methods) | `use` → `IMPORTS` planned | ✅ (self/same-file `exact`; cross-file `name_match`) |

Call edges carry an honest `resolution` (`exact` / `name_match` / `ambiguous`) and `confidence` — the skill instructs agents to verify non-exact edges.

---

## The graph

**Nodes:** `Repository`, `Directory`, `File`, `Class`, `Interface`, `Enum`, `Function`, `Variable`.
**Edges:** `CONTAINS`, `DEFINES`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `FEDERATES_TO`.

## MCP tools

- **`init_cpg_skeleton`** — index a repo and load it into the graph.
- **`get_context_profile`** — resolve a function/class and return its caller/callee neighborhood as pre-inlined prose + an `enrichment_needed` list (the JIT loop driver). `federated: true` spans nested repos.
- **`write_semantic_summary`** — attach a hash-stamped, validated plain-text summary to a node.
- **`read_cypher`** — read-only Cypher (write clauses rejected; default-deny procedure allowlist; results capped). `federated: true` scopes to the federation.
- **`reindex_file`** — refresh the graph after editing a file (extract-cache accelerated).

The `reposkein-mcp` binary also has two CLI subcommands: **`init`** (set up a repo) and **`doctor`** (health check).

---

## Benchmarks

RepoSkein is measured on two tracks, both under [`mcp/bench/`](mcp/bench/).

- **Track 1 — retrieval efficiency (deterministic, no LLM).** Compares RepoSkein's structural retrieval against a grep agent on hand-labeled code-navigation tasks, scoring precision-weighted F0.5 + context-token cost. On structural/impact queries RepoSkein surfaces exactly the right functions (F0.5 = 1.00 vs grep 0.11–0.71) with a **mean ~8.4× fewer context tokens** — using a cost model deliberately generous to grep (counting only matched function bodies, not whole files). See [`mcp/bench/README.md`](mcp/bench/README.md).
- **Track 2 — end-task benchmark (SWE-bench-Verified).** A minimal Anthropic tool-use agent loop where the *only* difference between arms is the navigation toolset — **A (RepoSkein MCP)** vs **B (grep/ripgrep)** — graded by the official `swebench` harness on resolve-rate + total tokens + turns. The loop, tools, and MCP client are unit-tested locally; the actual API+Docker run is opt-in/user-side. See [`mcp/bench/track2/README.md`](mcp/bench/track2/README.md).

---

## Neo4j backend (optional)

Most users never need this — the zero-infra JSONL store serves the graph directly. Neo4j is useful for very large graphs and raw Cypher at scale.

```sh
cd indexer && docker compose up -d        # neo4j on bolt://localhost:7687 (neo4j/reposkeintest)
NEO4J_PASSWORD=reposkeintest reposkein-indexer load /path/to/repo
```

Then point the MCP server at it with `REPOSKEIN_STORE=neo4j` and the `NEO4J_*` env vars (see [build from source](#build-from-source-contributors)).

---

## Build from source (contributors)

Prerequisites: Rust (stable), Node 24, Docker (only for the Neo4j backend / round-trip tests).

```sh
# 1. Build the native indexer
cd indexer && cargo build --release      # binary at indexer/target/release/reposkein-indexer

# 2. Index a repository (zero-infra — no Neo4j needed to serve)
reposkein-indexer init --hooks /path/to/repo          # installs git hooks + merge driver
reposkein-indexer index --name myrepo /path/to/repo   # writes .reposkein/*.jsonl + meta.json

# 3. Build the MCP server
cd mcp && npm install && npm run build

# 4. (optional) Neo4j backend
cd indexer && docker compose up -d
NEO4J_PASSWORD=reposkeintest reposkein-indexer load /path/to/repo
```

Wire the MCP server into your agent. **Zero-infra** (JSONL store, default):

```jsonc
{ "mcpServers": { "reposkein": {
  "command": "node",
  "args": ["/abs/path/reposkein/mcp/dist/index.js"],
  "env": {
    "REPOSKEIN_REPO_PATH": "/path/to/repo",
    "REPOSKEIN_INDEXER_BIN": "/abs/path/reposkein/indexer/target/release/reposkein-indexer"
  } } } }
```

Or with the **Neo4j backend**, add `"REPOSKEIN_STORE": "neo4j"`, `"NEO4J_URI": "neo4j://localhost:7687"`, `"NEO4J_USER": "neo4j"`, `"NEO4J_PASSWORD": "reposkeintest"`, and `"REPOSKEIN_REPO_ID": "<from .reposkein/meta.json>"`.

Then install the skills (`skills/`) so the agent navigates the graph instead of grepping.

---

## Repository layout

```
indexer/    Rust workspace: core · lang-common · lang-python · lang-ts · lang-rust · neo4j-io · cli
mcp/        @reposkein/mcp — TypeScript MCP server (tools, GraphStore backends, read-only guard)
mcp/bench/  retrieval benchmark (Track 1) + end-task SWE-bench harness (Track 2)
skills/     reposkein-graph-rag + reposkein-setup agent skills (skills.sh layout)
docs/       design docs
```

## Development

```sh
cd indexer && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
cd mcp && npm test          # DB-gated suites skip without NEO4J_PASSWORD
```

CI (GitHub Actions) runs the indexer test/fmt/clippy, the mcp build/test, and the Neo4j `load → export` byte-identical round-trip on every push and PR. Releases are cut by pushing a `v*` tag (builds the prebuilt binaries, creates a GitHub Release, and publishes `@reposkein/mcp` to npm).

## License

[Apache-2.0](./LICENSE).
