# RepoSkein docs

For humans.

Task-oriented index of everything under `docs/`. Package-level docs
(`mcp/`, `viz/`, `embed-server/`, benchmarks) live next to their code — see
the [root README's Documentation table](../README.md#documentation).

## Getting started / joining a team

- **Setting up a new repo, workspace, or agent config?** → [`INSTALL.md`](INSTALL.md) — written for agents to execute: a question tree (§1) covering one repo vs workspace, JSONL vs Neo4j, embeddings tier, and which agent CLIs to wire, then step-by-step setup (§2–§7) and troubleshooting (§9).
- **Joining a repo that already has RepoSkein set up?** → [`INSTALL.md` §0](INSTALL.md#0-joining-an-existing-reposkein-repo) — the one-command `git clone && cd && npx @reposkein/mcp init` path (auto-detects and wires up your agent's config).
- **Publishing a shareable, always-current view of the graph?** → [`HOSTING.md`](HOSTING.md) — GitHub Pages via `reposkein-mcp init --ci`, or any other static host.

## Using it day to day

- **What tools does the agent have, and how does it use them?** → [`TOOLS.md`](TOOLS.md) — the agent workflow, an example interaction, the full MCP tool reference, the `reposkein-mcp` CLI reference, and Architecture Decision Records (ADRs).
- **Visualizing the graph?** → [`VIEWER.md`](VIEWER.md) — the 3D constellation viewer (`reposkein-mcp view`), its lenses/overlays, and static export.
- **Wiring up semantic search?** → [`EMBEDDINGS.md`](EMBEDDINGS.md) — the optional hybrid embeddings tier: cloud (Voyage), local (Ollama), or self-hosted (`voyage-4-nano`).
- **Scaling past the default store?** → [`NEO4J.md`](NEO4J.md) — the optional Neo4j backend, for very large graphs or raw Cypher.

## Understanding the system

- **How is the graph built, resolved, and kept merge-smooth?** → [`ARCHITECTURE.md`](ARCHITECTURE.md) — the indexer/MCP pipeline, summary sharding, cross-repo federation, and the full per-language support matrix.
- **Recording or reviewing a design decision?** → [`TOOLS.md` — Architecture decisions (ADRs)](TOOLS.md#architecture-decisions-adrs) — how `record_decision` et al. anchor to the graph, and `reposkein-mcp adr export/import` for human-readable review.

## History

- **Migrations** — [`migrations/`](migrations/): [`2026-08-06-stop-committing-derived-graph.md`](migrations/2026-08-06-stop-committing-derived-graph.md) (moving `nodes.jsonl`/`edges.jsonl` out of git).
- **Policies** — [`policies/`](policies/): [`bulk-resummarization-sweeps.md`](policies/bulk-resummarization-sweeps.md) (why bulk summary rewrites must run serialized on `main`).

## See also

- [`../README.md`](../README.md) — the project front door.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — dev setup, invariants, adding a language.
