<div align="center">

<!-- animated gradient name banner (deep-navy → teal → amber) -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:070A12,45:2DD4BF,100:F2B84B&height=200&section=header&text=RepoSkein&fontColor=EAE7DC&fontSize=72&fontAlignY=38&animation=fadeIn&desc=Thread%20your%20repo%20into%20agent-ready%20context&descSize=17&descAlignY=60" width="100%" alt="RepoSkein — thread your repo into agent-ready context" />

<!-- animated typing tagline -->
<a href="https://github.com/reposkein/reposkein">
  <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=21&pause=1200&color=2DD4BF&center=true&vCenter=true&width=780&height=38&lines=A+deterministic+code+graph+for+AI+agents;Navigate+structure%2C+not+grep-and-guess;7+languages+%C2%B7+zero-infra+%C2%B7+git-native;~8.4x+fewer+context+tokens+than+grep" alt="A deterministic code graph for AI agents" />
</a>

<br /><br />

[![npm](https://img.shields.io/npm/v/@reposkein/mcp?style=for-the-badge&logo=npm&logoColor=EAE7DC&label=npm&labelColor=070A12&color=F2B84B)](https://www.npmjs.com/package/@reposkein/mcp)
[![CI](https://img.shields.io/github/actions/workflow/status/reposkein/reposkein/ci.yml?style=for-the-badge&logo=githubactions&logoColor=EAE7DC&label=CI&labelColor=070A12&color=2DD4BF)](https://github.com/reposkein/reposkein/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/reposkein/reposkein?style=for-the-badge&logo=github&logoColor=EAE7DC&label=release&labelColor=070A12&color=2DD4BF)](https://github.com/reposkein/reposkein/releases)
[![License](https://img.shields.io/badge/license-Apache_2.0-F2B84B?style=for-the-badge&labelColor=070A12)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-2DD4BF?style=for-the-badge&labelColor=070A12)](https://modelcontextprotocol.io)

[![skills.sh](https://skills.sh/b/reposkein/reposkein)](https://skills.sh/reposkein/reposkein)
&nbsp;[![Glama](https://glama.ai/mcp/servers/reposkein/reposkein/badges/score.svg)](https://glama.ai/mcp/servers/reposkein/reposkein)
&nbsp;[![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-2DD4BF?style=for-the-badge&labelColor=070A12)](https://mcpservers.org/servers/reposkein/reposkein)
&nbsp;[![ghcr](https://img.shields.io/badge/ghcr.io-embed--server-F2B84B?style=for-the-badge&logo=docker&logoColor=EAE7DC&labelColor=070A12)](https://github.com/reposkein/reposkein/pkgs/container/reposkein-embed)

</div>

## Introduction

**RepoSkein gives your AI coding agent a map of your codebase — so it navigates structure instead of grepping and guessing.**

It uses [Tree-sitter](https://tree-sitter.github.io/) to build a **deterministic Code Property Graph** of your repo — files, classes, functions, imports, and call edges — and serves it to any [MCP](https://modelcontextprotocol.io)-capable agent (Claude Code, Cursor, Codex, …). As the agent works, it writes short natural-language summaries onto graph nodes; those summaries are **versioned in git alongside the code**, so an agent's understanding becomes **shared team memory** that the next agent — or teammate — starts from.

**Who it's for:** developers using AI coding agents on real, large, or **nested/polyglot** codebases, who are tired of the agent burning its context window on grep; and teams who want that hard-won understanding to persist and be shared rather than re-derived every session.

- ⚡ **Zero-infra** — no database, no Docker. The graph lives in committed `.reposkein/*.jsonl` files.
- 🔒 **Deterministic** — same code → byte-identical graph. No LLM in the construction path.
- 🌐 **7 languages** — Python, TypeScript, JavaScript, Rust, Go, Java, C#.
- 🧩 **Local-first & git-native** — the graph and its summaries travel with your code.

| Your agent asks | RepoSkein answers — directly from the graph |
| --- | --- |
| "Who calls `charge()`?" | the exact callers, with one-line summaries |
| "What breaks if I change this?" | the impacted callers + the tests that cover them |
| "Where do I even start?" | ranked entry-point functions by meaning, not filename |
| "What usually changes with this file?" | co-change history from git |

> In a deterministic, no-LLM [benchmark](mcp/bench/), RepoSkein surfaces the right functions with a **mean ~8.4× fewer context tokens** than a grep-based agent on structural queries.

## Table of contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage — working with your agent](#usage--working-with-your-agent)
- [Supported languages](#supported-languages)
- [How it works](#how-it-works)
- [MCP tools](#mcp-tools)
- [Optional: semantic embeddings](#optional-semantic-embeddings)
- [Optional: Neo4j backend](#optional-neo4j-backend)
- [Benchmarks](#benchmarks)
- [Build from source](#build-from-source)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)
- [Contact](#contact)
- [License](#license)

## Prerequisites

- **Node.js 18+** — to run `npx @reposkein/mcp` (the indexer binary is fetched automatically).
- **An MCP-capable agent** — [Claude Code](https://claude.com/claude-code), Cursor, Codex, Zed, etc.
- A **git repository** to index (RepoSkein installs git hooks and commits the graph).
- *Optional:* **Docker** (only for the [embeddings server](#optional-semantic-embeddings) or the [Neo4j backend](#optional-neo4j-backend)); **Rust** (only to [build from source](#build-from-source)).

## Installation

In the repo you want your agent to understand:

```sh
npx @reposkein/mcp init
```

This downloads the indexer for your platform, installs git hooks + the navigation skill, **builds the initial code graph**, and prints an MCP config block. Then:

1. **Add the printed config to your agent** (e.g. Claude Code's `.mcp.json`):
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
2. **Verify and commit the graph** (`init` already built it):
   ```sh
   reposkein-mcp doctor .         # ✓ binary  ✓ indexed (N nodes)  ✓ ready
   git add .reposkein && git commit -m "add RepoSkein code graph"
   ```
   Re-index after big changes with `reposkein-mcp index .` (or the agent's `reindex_file` tool).
3. **Ask your agent** *"what calls this function?"* or *"what breaks if I change X?"* — it answers from the graph.

> **Prefer to let your agent set it up?** Install the [skills](#agent-skills) and tell it to **run the `reposkein-setup` skill** — it installs, indexes, and verifies everything:
> ```sh
> npx skills add reposkein/reposkein --all
> ```

**Platforms:** prebuilt binaries for macOS (Apple Silicon), Linux (x64/arm64), and Windows (x64). Elsewhere, point `REPOSKEIN_INDEXER_BIN` at a [from-source](#build-from-source) build.

## Usage — working with your agent

You ask in plain language; the bundled **`reposkein-graph-rag`** skill drives the tools. The natural loop:

1. **Find where to start** — `semantic_find("jwt auth validation")` ranks the right functions by meaning, no symbol name needed. → *"where's the rate limiter?"*
2. **Understand it** — `get_context_profile` returns the node's callers + callees as ready-to-read prose (`hops: 2` widens, `federated: true` spans nested repos).
3. **Before you change it** — `impact` lists transitive callers (what could break) split from the tests that cover it (what to run). → *"what breaks if I change `charge()`?"*
4. **What moves with it** — `get_temporal_context` surfaces files that historically change together, plus churn and ownership. → *"what usually changes with the auth config?"*
5. **Record what you learned** — `write_semantic_summary` attaches a 1–3 sentence note to the node, committed to git for the next agent/teammate.
6. **After editing** — `reindex_file` refreshes the graph for the changed file.

<details>
<summary><b>Example interaction</b></summary>

```text
You:    Refactor how we validate auth tokens — what's involved?

Agent:  → semantic_find("validate auth token")        → resolves auth.validate_jwt
        → get_context_profile(auth.validate_jwt)       → 3 callers, 2 callees (+ summaries)
        → impact(auth.validate_jwt)                    → 6 impacted functions, 4 covering tests
        → get_temporal_context("src/auth/jwt.py")      → co-changes with config/keys.py (conf 0.8)

Agent:  "validate_jwt is called by the login, refresh, and middleware paths;
         changing its signature touches 6 functions and 4 tests (test_jwt.py,
         test_middleware.py, …). Heads up: jwt.py historically changes together
         with config/keys.py — you'll likely need to update both."
```

> 🎥 A short screen recording is on the roadmap — see [Documentation](#documentation).
</details>

### Agent skills

RepoSkein ships two cross-agent [Agent Skills](https://skills.sh) — `npx skills add reposkein/reposkein --all` installs both into Claude Code, Cursor, Codex, and 70+ agents:

- **`reposkein-setup`** — installs RepoSkein in a repo and verifies it's running (binary → index → MCP reachability). Ask your agent to run it.
- **`reposkein-graph-rag`** — teaches your agent *when* to use each tool (the loop above). `reposkein-mcp init` installs it automatically for Claude Code.

## Supported languages

| Language | Definitions | Imports → edges | Cross-file calls |
| --- | --- | --- | --- |
| Python | functions, classes, methods, nested defs, vars | ✅ relative / absolute / aliased | import-resolved (`exact`) |
| TypeScript / TSX | classes, interfaces, enums, methods, arrows | ✅ named / default / aliased / `* as ns` | import-resolved (`exact`) |
| JavaScript / JSX | *(via the TS grammar)* | ✅ ES imports *(no CommonJS yet)* | import-resolved (`exact`) |
| Rust | fns, structs, traits, enums, `impl` methods | ✅ `use` (groups, aliases, globs, `pub use` chains; workspace-aware) | import-resolved (`exact`) |
| Go | funcs, methods (`Type.method`), structs, interfaces | *not yet (cross-package planned)* | same-package (same-dir); cross-package by name |
| Java | classes, records, interfaces, enums, methods, constructors, fields | ✅ package-path *(no wildcard/static yet)* | import-resolved (`exact`) |
| C# | classes, structs, records, interfaces, enums, methods, properties | *not yet (cross-namespace planned)* | same-dir; cross-namespace by name |

**What resolves — honestly.** Every edge carries a `resolution` (`exact` / `name_match` / `ambiguous`) + confidence, so your agent knows what to trust. Same-file calls, `self`/`this` methods, and **import-followed free-function calls resolve `exact`**. Python **module-alias calls** (`import foo as f; f.bar()`) resolve `exact` to the target module's function. **Cross-file INHERITS/IMPLEMENTS edges** are resolved repo-wide: import-followed bases resolve `exact` (confidence 1.0); unique same-directory or repo-wide bases resolve `name_match` (0.8/0.7); ambiguous bases are skipped to avoid false hierarchy edges — and bases that live in a **federated child repo** are stitched into cross-repo heritage edges at load time. Go's **struct/interface embedding** (`type Dog struct { Animal }`) is captured as INHERITS. Constructors emit a distinct **`INSTANTIATES`** edge (`new Foo()` in TS/Java/C#, struct literals in Rust, and Python `Foo()` whose name resolves to a class) so an agent can ask *who creates instances of this type* — resolved against the type index and skipped when ambiguous. Because the graph is **type-free by design** (deterministic, no compiler in the loop), **instance-method calls (`obj.method()`) resolve by name** (≤ `name_match`) and overloaded calls are flagged `ambiguous`. Go and C# don't emit import edges yet, so their cross-package/namespace calls resolve by name (same-package/-directory calls *do* resolve). These limits are inherent to the zero-infra, type-free design; an optional type-aware layer (SCIP/LSP) is on the roadmap. [Adding a language](CONTRIBUTING.md) is a well-trodden path — contributions welcome.

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
- **Meaning is just-in-time.** Summaries are written as the agent visits nodes; they're content-hash-stamped (so they flag stale when code changes) and committed to git.
- **Local-first.** The committed JSONL is the source of truth; the optional [Neo4j backend](#optional-neo4j-backend) is a reconstructable projection most users never need.

### Cross-repo federation

Got nested repositories (a monorepo of indexed repos)? RepoSkein discovers them, links them with `FEDERATES_TO`, and stitches **cross-repo call, import, and heritage edges** (`INHERITS`/`IMPLEMENTS` to a base in a child repo) at load time. Pass `federated: true` to traverse across repo boundaries. Federation edges are derived at load (never committed), so each repo stays independently deterministic.

## MCP tools

| Tool | What it does |
| --- | --- |
| `semantic_find` | find where to start — rank functions/classes by meaning (lexical BM25F; optional [embeddings](#optional-semantic-embeddings)) |
| `get_context_profile` | resolve a function/class → its caller/callee neighborhood as ready-to-read prose |
| `impact` | transitive callers split into impacted code vs covering tests |
| `get_temporal_context` | git-derived co-change, churn, and ownership for a file |
| `read_cypher` | read-only graph queries (writes rejected, results capped) |
| `write_semantic_summary` | attach a hash-stamped summary to a node |
| `init_cpg_skeleton` | build/rebuild the graph |
| `reindex_file` | refresh after editing a file |

The `reposkein-mcp` CLI adds **`init`** (set up a repo) and **`doctor`** (health check).

## Optional: semantic embeddings

By default `semantic_find` is **deterministic and lexical** (BM25F — zero-infra, no keys). You can opt into a **hybrid** tier (lexical + embedding cosine, fused via RRF) for fuzzier queries. It's **default-off**, vectors are cached in `.reposkein/local/embeddings/` (gitignored, never committed), and it **falls back to lexical** automatically on any error. Set env vars on the MCP server and **pick one**:

### A) Voyage AI — cloud, easiest, best for code

[Get a key](https://dashboard.voyageai.com/), then:
```sh
REPOSKEIN_EMBED_PROVIDER=voyage
VOYAGE_API_KEY=pa-...
# optional: REPOSKEIN_EMBED_MODEL=voyage-code-3   # default — code-specialized
```
> Sends document strings (qualified names, signatures, summaries) to Voyage's API. Use B or C if you can't egress code.

### B) Ollama — local, off-the-shelf, no key

```sh
ollama pull nomic-embed-text     # 768-dim (or mxbai-embed-large=1024, bge-m3=1024)
```
```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:11434/v1/embeddings
REPOSKEIN_EMBED_MODEL=nomic-embed-text
REPOSKEIN_EMBED_DIMS=768          # must match the model
```

### C) Voyage's open model, self-hosted — offline + Voyage quality

`voyage-4-nano` (Apache-2.0) is a custom Qwen3-based model Ollama can't run, so RepoSkein ships a prebuilt server. The image is **published to GHCR — public and multi-arch (amd64/arm64)** — so there's nothing to build:

```sh
docker run -p 8080:8080 -v reposkein-hf:/root/.cache/huggingface \
  ghcr.io/reposkein/reposkein-embed          # auto-picks your architecture; first run downloads the model
```
```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:8080/v1/embeddings
REPOSKEIN_EMBED_MODEL=voyage-4-nano
REPOSKEIN_EMBED_DIMS=1024         # must equal the server's EMBED_DIMS
```

Everything stays on your machine. The image is **CPU-only and runs with no NVIDIA GPU** on Apple Silicon / ARM unified-memory, x64 Linux, and Windows (CI builds + smoke-tests both arches). Docker can't use Apple's Metal/MPS — for that, run the server natively with `EMBED_DEVICE=mps`. Full details (root `docker compose up`, GPU, other models): [`embed-server/README.md`](embed-server/README.md).

> `REPOSKEIN_EMBED_DIMS` on the client **must match** the model's output dimension, or cosine scoring is skipped.

## Optional: Neo4j backend

The zero-infra JSONL store is the default. Neo4j is an optional projection for very large graphs and raw Cypher at scale:

```sh
docker compose --profile neo4j up -d          # from the repo root
NEO4J_PASSWORD=reposkeintest reposkein-indexer load .
```
Then set `REPOSKEIN_STORE=neo4j` + the `NEO4J_*` env vars on the MCP server. (`REPOSKEIN_STORE=auto`, the default, uses JSONL when present and falls back to Neo4j only if configured.)

## Benchmarks

Two tracks, both under [`mcp/bench/`](mcp/bench/):

- **Track 1 — retrieval efficiency** (deterministic, no LLM): RepoSkein vs a grep agent on hand-labeled tasks → **mean ~8.4× fewer context tokens** on structural queries, at F0.5 = 1.00 vs grep 0.11–0.71. [Details.](mcp/bench/README.md)
- **Track 2 — end-task** ([SWE-bench-Verified](mcp/bench/track2/README.md)): a minimal agent loop where the *only* difference is the navigation toolset (RepoSkein vs grep), graded on resolve-rate + tokens + turns. Built + unit-tested; the API+Docker run is opt-in.

## Build from source

Requirements: Rust (stable), Node 24. Docker only for the optional Neo4j backend.

```sh
cd indexer && cargo build --release        # → indexer/target/release/reposkein-indexer
cd ../mcp  && npm install && npm run build
```

Wire it into your agent with `command: node`, `args: [".../mcp/dist/index.js"]`, env `REPOSKEIN_REPO_PATH` + `REPOSKEIN_INDEXER_BIN`. Tests: `cd indexer && cargo test && cargo clippy --all-targets -- -D warnings`; `cd mcp && npm test`.

### Repository layout

```
indexer/      Rust workspace: core, lang-{python,ts,rust,go,java,csharp}, lang-common, neo4j-io, cli
mcp/          @reposkein/mcp — the TypeScript MCP server (tools + graph-store backends)
mcp/bench/    benchmarks: retrieval efficiency (Track 1) + end-task SWE-bench harness (Track 2)
skills/       reposkein-graph-rag + reposkein-setup — cross-agent skills (skills.sh)
embed-server/ one-command local embedding server (voyage-4-nano) for hybrid semantic_find
```

## Documentation

| Doc | What's in it |
| --- | --- |
| [`mcp/README.md`](mcp/README.md) | the `@reposkein/mcp` package — tools, config, env vars |
| [`embed-server/README.md`](embed-server/README.md) | the local embedding server — Docker/GHCR, platforms, GPU |
| [`mcp/bench/README.md`](mcp/bench/README.md) | Track 1 retrieval benchmark — method + results |
| [`mcp/bench/track2/README.md`](mcp/bench/track2/README.md) | Track 2 end-task (SWE-bench) harness |
| [`CHANGELOG.md`](CHANGELOG.md) | release history (Keep a Changelog) |
| [`skills/`](skills/) | the two cross-agent skills |

## Contributing

Contributions are welcome — bug fixes, new languages, docs. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the dev setup, the determinism invariants you must preserve, and the step-by-step recipe for **adding a new language** (it's a well-trodden path — Go, Java, and C# were each added the same way). RepoSkein uses [Conventional Commits](https://www.conventionalcommits.org) and keeps CI green (determinism gates + clippy + tests).

## Acknowledgements

- [Tree-sitter](https://tree-sitter.github.io/) — the parsers behind every language extractor.
- [Model Context Protocol](https://modelcontextprotocol.io) — the agent integration standard.
- [Voyage AI](https://voyageai.com) — `voyage-code-3` and the open-weight `voyage-4-nano` powering the optional embeddings tier.
- Discovery via [Glama](https://glama.ai/mcp/servers), [skills.sh](https://skills.sh), [mcpservers.org](https://mcpservers.org), and the awesome-mcp community lists.
- README header by [capsule-render](https://github.com/kyechan99/capsule-render) + [readme-typing-svg](https://github.com/DenverCoder1/readme-typing-svg).

## Contact

- 🐛 **Bugs / features:** [open an issue](https://github.com/reposkein/reposkein/issues)
- 💬 **Questions / ideas:** [GitHub Discussions](https://github.com/reposkein/reposkein/discussions)

## License

[Apache-2.0](./LICENSE).

<div align="center">
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:F2B84B,55:2DD4BF,100:070A12&height=120&section=footer" width="100%" alt="" />
<sub>Built for agents that read structure, not noise.</sub>
</div>
