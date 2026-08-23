<div align="center">

<!-- animated gradient name banner (deep-navy → teal → amber) -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:070A12,45:2DD4BF,100:F2B84B&height=200&section=header&text=RepoSkein&fontColor=EAE7DC&fontSize=72&fontAlignY=38&animation=fadeIn&desc=Thread%20your%20repo%20into%20agent-ready%20context&descSize=17&descAlignY=60" width="100%" alt="RepoSkein — thread your repo into agent-ready context" />

[![npm](https://img.shields.io/npm/v/@reposkein/mcp?style=for-the-badge&logo=npm&logoColor=EAE7DC&label=npm&labelColor=070A12&color=F2B84B)](https://www.npmjs.com/package/@reposkein/mcp)
[![CI](https://img.shields.io/github/actions/workflow/status/reposkein/reposkein/ci.yml?style=for-the-badge&logo=githubactions&logoColor=EAE7DC&label=CI&labelColor=070A12&color=2DD4BF)](https://github.com/reposkein/reposkein/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/reposkein/reposkein?style=for-the-badge&logo=github&logoColor=EAE7DC&label=release&labelColor=070A12&color=2DD4BF)](https://github.com/reposkein/reposkein/releases)
[![License](https://img.shields.io/badge/license-Apache_2.0-F2B84B?style=for-the-badge&labelColor=070A12)](./LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-F2B84B?style=for-the-badge&logo=kofi&logoColor=EAE7DC&labelColor=070A12)](https://ko-fi.com/mongx)
[![Lulu MCPs](https://getlulu.dev/api/mcps/badge/mcp-reposkein)](https://getlulu.dev/mcps/mcp-reposkein)

<sub>Listed on: [skills.sh](https://skills.sh/reposkein/reposkein) · [Glama](https://glama.ai/mcp/servers/reposkein/reposkein) · [mcpservers.org](https://mcpservers.org/servers/reposkein/reposkein) · [ghcr.io](https://github.com/reposkein/reposkein/pkgs/container/reposkein-embed)</sub>

**[🔭 Live demo →](https://reposkein.github.io/reposkein/)** — RepoSkein's own graph, rendered as an interactive 3D constellation in your browser.

**Get running in one line:** `npx @reposkein/mcp init` — full walkthrough in [Installation](#installation).

</div>

## Introduction

**RepoSkein gives your AI coding agent a map of your codebase — so it navigates structure instead of grepping and guessing.**

It uses [Tree-sitter](https://tree-sitter.github.io/) to build a **deterministic Code Property Graph** of your repo — files, classes, functions, imports, and call edges — and serves it to any [MCP](https://modelcontextprotocol.io)-capable agent (Claude Code, Cursor, Codex, …). As the agent works, it writes short natural-language summaries onto graph nodes; those summaries are **versioned in git alongside the code**, so an agent's understanding becomes **shared team memory** that the next agent — or teammate — starts from.

**Who it's for:** developers using AI coding agents on real, large, or **nested/polyglot** codebases, who are tired of the agent burning its context window on grep; and teams who want that hard-won understanding to persist and be shared rather than re-derived every session.

- ⚡ **Zero-infra** — no database, no Docker. The graph lives in plain `.reposkein/*.jsonl` files, rebuilt from your working tree in seconds.
- 🔒 **Deterministic** — same code → byte-identical graph. No LLM in the construction path.
- 🌐 **7 languages** — Python, TypeScript, JavaScript, Rust, Go, Java, C#.
- 🧩 **Local-first & git-native** — the summaries your agents write are committed and travel with your code.

| Your agent asks | RepoSkein answers — directly from the graph |
| --- | --- |
| "Who calls `charge()`?" | the exact callers, with one-line summaries |
| "What breaks if I change this?" | the impacted callers + the tests that cover them |
| "Where do I even start?" | ranked entry-point functions by meaning, not filename |
| "What usually changes with this file?" | co-change history from git |

<a id="benchmarks"></a>
> In a deterministic, no-LLM [benchmark](mcp/bench/), RepoSkein surfaces the right functions with a **mean ~8.4× fewer context tokens** than a grep-based agent on structural queries.

<a id="usage--working-with-your-agent"></a><a id="mcp-tools"></a><a id="agent-skills"></a>
The bundled `reposkein-graph-rag` skill drives a `semantic_find → get_context_profile → impact → get_temporal_context → write_semantic_summary → reindex_file` loop, so you just ask in plain language. Full workflow, an example interaction, and the tool-by-tool + CLI reference: **[`docs/TOOLS.md`](docs/TOOLS.md)**.

## Table of contents

- [For teams](#for-teams)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Supported languages](#supported-languages)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)
- [Contact](#contact)
- [License](#license)

## For teams

Joining a repo that already has RepoSkein set up? One command, no questions asked:

```sh
git clone <repo-url> && cd <repo> && npx @reposkein/mcp init
```

`init` detects the committed `.reposkein/meta.json`, reuses its config, and wires up your agent's MCP config automatically. Publish a durable, shareable view of the graph with a [**hosted constellation**](docs/HOSTING.md) (GitHub Pages via `reposkein-mcp init --ci`) — and because summaries are committed to git, they're **shared team memory**: every teammate's agent starts from what previous agents already learned, not from scratch.

**Support:** if RepoSkein is useful, [**Ko-fi**](https://ko-fi.com/mongx) support funds hosted-constellation infrastructure and indexer maintenance — supporters get an ad-free experience once sponsorship tiers ship.

## Prerequisites

- **Node.js 18+** — to run `npx @reposkein/mcp` (the indexer binary is fetched automatically).
- **An MCP-capable agent** — [Claude Code](https://claude.com/claude-code), Cursor, Codex, Zed, etc.
- A **git repository** to index (RepoSkein installs git hooks and reads git history for `get_temporal_context`).
- *Optional:* **Docker** (only for the [embeddings server](docs/EMBEDDINGS.md) or the [Neo4j backend](docs/NEO4J.md)); **Rust** (only to [build from source](CONTRIBUTING.md#dev-setup)).

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
2. **Verify the graph** (`init` already built it):
   ```sh
   reposkein-mcp doctor .         # ✓ binary  ✓ indexed (N nodes)  ✓ ready
   git add .reposkein/meta.json .reposkein/config.toml && git commit -m "add RepoSkein config"
   ```
   `nodes.jsonl` and `edges.jsonl` are derived from your working tree and git-ignored — a clone rebuilds them on first use. Re-index after big changes with `reposkein-mcp index .` (or the agent's `reindex_file` tool).
3. **Ask your agent** *"what calls this function?"* or *"what breaks if I change X?"* — it answers from the graph.

> **Prefer to let your agent set it up?** Install the [skills](docs/TOOLS.md#agent-skills) and tell it to **run the `reposkein-setup` skill** — it installs, indexes, and verifies everything:
> ```sh
> npx skills add reposkein/reposkein --all
> ```

**Platforms:** prebuilt binaries for macOS (Apple Silicon), Linux (x64/arm64), and Windows (x64). Elsewhere, point `REPOSKEIN_INDEXER_BIN` at a [from-source](CONTRIBUTING.md#dev-setup) build.

### Let your agent install it for you

For complex setups — multi-repo workspaces, Neo4j backend, the local embedding server, or wiring up agents besides Claude Code (OpenCode, Cursor, Codex, Continue, Cline, …) — paste this into any MCP-capable agent and it'll walk you through:

> Install RepoSkein in this workspace. Read [`docs/INSTALL.md`](docs/INSTALL.md) (or `https://github.com/reposkein/reposkein/blob/main/docs/INSTALL.md`), walk me through the question tree in §1, then execute §2 onward. If anything fails, troubleshoot via §9 — don't silently skip steps. Confirm with `reposkein-mcp doctor .` per repo and a `semantic_find` smoke test before claiming done.

[`docs/INSTALL.md`](docs/INSTALL.md) is written for agents: it covers the decision tree (one repo vs workspace, JSONL vs Neo4j, lexical vs cloud vs local embeddings, which agent CLIs to wire), per-agent config schemas (`.mcp.json`, `opencode.json`, `.cursor/mcp.json`, Continue, Codex, Cline, …), the Apple-Silicon `mps` native embed-server recipe, and a troubleshooting table.

## Supported languages

Python, TypeScript, JavaScript, Rust, Go, Java, C# — with an honest per-language matrix of what resolves `exact` vs by-name vs `ambiguous`. Full table + the resolution rules: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#supported-languages)**. [Adding a language](CONTRIBUTING.md#adding-a-new-language) is a well-trodden path — contributions welcome.

<a id="how-it-works"></a><a id="cross-repo-federation"></a><a id="visualize-the-graph--the-constellation-viewer"></a><a id="optional-semantic-embeddings"></a><a id="optional-neo4j-backend"></a><a id="build-from-source"></a><a id="repository-layout"></a>
**Going deeper:** [how the graph is built + cross-repo federation](docs/ARCHITECTURE.md) · [the constellation viewer](docs/VIEWER.md) · [semantic embeddings](docs/EMBEDDINGS.md) · [Neo4j backend](docs/NEO4J.md) · [shared remote server](docs/REMOTE.md) · [building from source + repo layout](CONTRIBUTING.md).

## Documentation

Full index, task-oriented: **[`docs/README.md`](docs/README.md)**.

| Doc | What's in it |
| --- | --- |
| [`mcp/README.md`](mcp/README.md) | the `@reposkein/mcp` package — tools, config, env vars, session usage stats |
| [`viz/README.md`](viz/README.md) | the `@reposkein/viz` constellation viewer — architecture, dev/build |
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
- README header by [capsule-render](https://github.com/kyechan99/capsule-render).

## Contact

- 🐛 **Bugs / features:** [open an issue](https://github.com/reposkein/reposkein/issues)
- 💬 **Questions / ideas:** [GitHub Discussions](https://github.com/reposkein/reposkein/discussions)

## License

[Apache-2.0](./LICENSE).

<div align="center">
<img src="https://capsule-render.vercel.app/api?type=waving&color=0:F2B84B,55:2DD4BF,100:070A12&height=120&section=footer" width="100%" alt="" />
<sub>Built for agents that read structure, not noise.</sub>
</div>
