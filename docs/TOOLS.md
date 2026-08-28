# MCP tools

For humans and agents.

Moved out of the [README](../README.md) so the front door stays short — everything an agent does with RepoSkein, tool by tool, plus the CLI.

## The agent workflow

You ask in plain language; the bundled **`reposkein-graph-rag`** skill drives the tools. The natural loop:

1. **Find where to start** — `semantic_find("jwt auth validation")` ranks the right functions by meaning, no symbol name needed. → *"where's the rate limiter?"*
2. **Understand it** — `get_context_profile` returns the node's callers + callees as ready-to-read prose (`hops: 2` widens, `federated: true` spans nested repos).
3. **Before you change it** — `impact` lists transitive callers (what could break) split from the tests that cover it (what to run). → *"what breaks if I change `charge()`?"*
4. **What moves with it** — `get_temporal_context` surfaces files that historically change together, plus churn and ownership. → *"what usually changes with the auth config?"*
5. **Record what you learned** — `write_semantic_summary` attaches a 1–3 sentence note to the node, landing in `.reposkein/summaries/<xx>.jsonl` for you to commit for the next agent/teammate.
6. **After editing** — `reindex_file` refreshes the graph for the changed file.

**Multi-repo workspace?** Start with `list_repos` to see what RepoSkein discovered, then `select_repo` (by `path` or `name`) before calling the tools above — only needed when more than one sibling repo is found with none selected. Single-repo setups need no selection: resolution is zero-config (see [`ARCHITECTURE.md`](ARCHITECTURE.md#how-it-works) / [`../mcp/README.md`](../mcp/README.md#repo-resolution-zero-config)).

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

</details>

> 🎥 A short screen recording is on the roadmap — see [Documentation](../README.md#documentation).

### Agent skills

RepoSkein ships two cross-agent [Agent Skills](https://skills.sh). Claude Code users get both automatically with the [plugin](../README.md#installation) (`/plugin install reposkein`, namespaced `/reposkein:…`); everywhere else, `npx skills add reposkein/reposkein --all` installs them into Cursor, Codex, and 70+ agents:

- **`reposkein-setup`** — installs RepoSkein in a repo and verifies it's running (binary → index → MCP reachability). Ask your agent to run it.
- **`reposkein-graph-rag`** — teaches your agent *when* to use each tool (the loop above), including when to record a decision. `reposkein-mcp init` installs it automatically for Claude Code.

## Tool reference

| Tool | What it does |
| --- | --- |
| `list_repos` | enumerate the repos discovered by resolution — path, name, cheap node/edge counts, and a `graph_tracked` flag when the derived graph is still committed (REP-35). One entry in single-repo mode; workspace mode lists every sibling repo found. |
| `select_repo` | set the session-active repo (by `path` or `name` from `list_repos`) for every repo-scoped tool below, for the rest of the connection. |
| `semantic_find` | find where to start — rank functions/classes by meaning (lexical BM25F; optional [embeddings](EMBEDDINGS.md)). "Why" questions also surface `Decision` rows — follow up with `get_decision`. |
| `get_context_profile` | resolve a function/class → its caller/callee neighborhood as ready-to-read prose, plus up to 5 governing decisions. |
| `impact` | transitive callers split into impacted code vs covering tests, plus governing decisions over the target and impacted rows. |
| `get_temporal_context` | git-derived co-change, churn, and ownership for a file. |
| `read_cypher` | read-only graph queries (writes rejected, results capped at 200 rows / 64KB). |
| `write_semantic_summary` | attach a hash-stamped summary to a node. |
| `init_cpg_skeleton` | build/rebuild the graph. |
| `reindex_file` | refresh after editing a file. |
| `record_decision` | record an Architecture Decision Record (ADR) anchored to the graph nodes/paths it governs; lands as `proposed` by default; pass `supersedes` to replace an earlier decision. |
| `set_decision_status` | change an ADR's lifecycle status: `proposed→accepted`, `proposed→rejected`, `accepted→deprecated` (`superseded` only happens via `record_decision`'s `supersedes`). |
| `reaffirm_decision` | re-stamp an ADR's anchors after verifying the changed code still conforms, clearing staleness without superseding. |
| `reanchor_decision` | repair an ADR's anchors after renames/moves — rebinds on confident matches only, reports ambiguous/orphaned anchors untouched. |
| `list_decisions` | list ADRs (id, title, status, anchor drift counts), filterable by status, anchor, or free-text. |
| `get_decision` | full ADR record: context, decision, consequences, alternatives, live anchor states, and the supersession chain. |

## CLI reference

| Command | What it does |
| --- | --- |
| `reposkein-mcp init [path]` | set up a repo — indexer, git hooks, skill, initial graph. `--ci` also writes the GitHub Pages publish workflow ([`HOSTING.md`](HOSTING.md)); on a repo joined from a committed `.reposkein/meta.json`, auto-detects and writes local agent MCP config instead of printing a snippet. |
| `reposkein-mcp doctor [path]` | health check (indexer binary, index, repo id, hooks, graph freshness). `--json` for machine output; `--ci` additionally fails on a stale graph, missing hooks, or an unsplit legacy `summaries.jsonl`. |
| `reposkein-mcp index [path]` | (re)build the committed graph. |
| `reposkein-mcp view [path]` | open the [constellation viewer](VIEWER.md) (`--export <dir>` for a static site). |
| `reposkein-mcp stats [path]` | session usage report — calls by tool, top queried nodes/files, ADRs/summaries written, session duration, and an estimated context-tokens-saved-vs-grep number. |
| `reposkein-mcp adr export/import [path] [dir]` | see [Architecture decisions](#architecture-decisions-adrs) below. |
| `reposkein-mcp adr reanchor [path] [--dry-run] [--id <adr-id>]` | see [Architecture decisions](#architecture-decisions-adrs) below. |
| `reposkein-mcp serve --http [path]` | **advanced, optional** — one shared server: MCP over Streamable HTTP + the viewer and `/api/*` in one process, bearer-token auth, read-only by default, re-indexing when the served checkout's HEAD moves. Not needed for normal use; stdio is the default transport. See [`REMOTE.md`](REMOTE.md). |

## Architecture decisions (ADRs)

Decisions recorded via `record_decision` (and friends, above) live as one committed JSON file per decision at `.reposkein/decisions/<date>-<slug>.json` — file-per-decision so parallel branches never merge-conflict on a forge, the same lesson the [summary shards](INSTALL.md#42-merge-behaviour-for-reposkein) apply. Each has a portable `adr:<date>-<slug>` id, an immutable body (`body_hash`-stamped), and anchors — graph nodes or path prefixes the decision governs — whose state (`current`/`stale`/`moved`/`orphaned`) is recovered via content-hash matching as code changes around them.

`reposkein-mcp doctor` validates the decision log (parse failures, duplicate ids, tampered `body_hash`, dangling/cyclic supersession) as a non-critical, degrade-don't-block check.

For human review or interop with `adr-tools` / `log4brains` / `Backstage`, `reposkein-mcp adr export [path] [dir]` renders the committed records to Nygard-format markdown under `docs/adr/` (derived — the JSON records stay the system of record). `reposkein-mcp adr import [path] [dir]` reads an existing Nygard/MADR-style markdown ADR log the other direction, creating unanchored records a human can later reaffirm.

### Anchor lifecycle: reanchor vs reaffirm vs supersede

Anchors are stamped at record time and drift as code evolves: `stale` (node
lives, content changed), `moved` (id dead, content found elsewhere),
`orphaned` (nothing matches). Three distinct responses:

- **`adr reanchor` / `reanchor_decision`** — mechanical pointer repair, no
  judgment. Rebinds an anchor when its id resolves under the current repo id
  or its recorded content hash matches exactly one live node (renames,
  qualified-name churn). Never guesses: ambiguous and orphaned anchors are
  reported and left untouched. Staleness survives the repair. Prose and the
  body hash are never affected; the repair stamps `reanchored_at` and keeps
  the previous anchors in `anchor_history`.
- **`reaffirm_decision`** — the semantic judgment "this decision is still
  correct after the code changed": re-stamps anchor hashes from the live
  graph, clearing stale flags. Use after actually reviewing the changed code.
- **`record_decision` with `supersedes`** — the decision itself changed;
  record the new one and let it supersede the old.

`reposkein-mcp doctor` counts drifted anchors (`decisions_anchors`);
`adr reanchor --dry-run` prints the full repair plan without writing. Exit
codes: 0 clean, 1 partial (unresolved anchors remain), 2 error.

## See also

- [`../README.md`](../README.md) — the front door.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the graph these tools query is built.
- [`../mcp/README.md`](../mcp/README.md) — the `@reposkein/mcp` package: full config/env var reference, session usage stats detail.
