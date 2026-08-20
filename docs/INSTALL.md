# RepoSkein — Agent Install Guide

> **For agents:** the user pasted this document because they want you to install [RepoSkein](https://github.com/reposkein/reposkein) in their repo (or a workspace containing several repos). RepoSkein is a deterministic code-graph MCP server. **Read this whole document first.** Then ask the user the question-tree in §1, then execute §2–§7 in order. The minimal happy path is `npx @reposkein/mcp init` per git repo — everything else is optional.
>
> **For humans:** prefer the [README](../README.md) for usage. This file is for handing off to an agent ("here, install it for me, ask me what I need").

---

## TL;DR (the one-liner an agent should already know how to run)

```sh
# Per git repo. Indexes, installs hooks, installs the navigation skill, prints MCP config.
npx @reposkein/mcp init
```

Everything else in this doc handles **(a)** multi-repo workspaces, **(b)** Neo4j backend, **(c)** semantic embeddings (cloud Voyage / local Ollama / local voyage-4-nano), **(d)** wiring into a specific agent (Claude Code / OpenCode / Cursor / Codex / Continue / Cline / …), and **(e)** verification.

---

## 1. Question tree — ASK THE USER BEFORE INSTALLING

Walk the user through these decisions in order. Use the user's answers to pick branches in §2–§7. Don't ask all at once; ask conversationally.

### Q1 — Is the target one repo, or a workspace containing several repos?

- **One git repo** → install once, in that repo.
- **A workspace folder containing multiple git repos** (e.g. `~/REPOS/MyOrg/{repo-a,repo-b,…}`) → install **per sub-repo**, then optionally wire **federation** so queries can span repos.
- **The workspace folder itself is *also* a git repo** → install in the parent first; nested repos are auto-discovered for federation.

**If multi-repo:** the workspace root is NOT required to be a git repo. RepoSkein installs into each child git repo separately; federation is derived at query time.

### Q2 — Storage backend: JSONL (default) or Neo4j?

| Backend | Best for | Setup |
|---|---|---|
| **JSONL** (default, "zero-infra") | Any size up to ~100k symbols. Rebuilt from the working tree. Works offline. | Nothing — `init` writes it. |
| **Neo4j** | Very large graphs (>100k symbols), raw Cypher queries, multi-tenant, query-perf-sensitive workloads. | Docker (`docker compose --profile neo4j up -d` from a checkout of this repo, or any Neo4j 5.x reachable over Bolt). |

If the user is unsure → recommend **JSONL**. Suggest Neo4j only when they explicitly mention scale, multi-repo dashboards, or Cypher.

If **Neo4j**: ask for `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` or run the bundled docker-compose Neo4j (which uses `neo4j://localhost:7687`, user `neo4j`, password `reposkeintest`).

### Q3 — Semantic embeddings: off, cloud, or local?

`semantic_find` works deterministically out-of-the-box (BM25F lexical) with **no embeddings**. The hybrid embedding tier is **opt-in** and fuses lexical + cosine via RRF.

| Tier | Latency | Privacy | Setup |
|---|---|---|---|
| **Lexical-only** (default) | Instant | Local | None |
| **Voyage AI (cloud)** | Best quality for code; tiny network round-trip | Sends doc strings (qualified names, signatures, summaries) to Voyage | Get a key at <https://dashboard.voyageai.com/> |
| **Ollama (local)** | Local CPU/GPU | Local | `ollama pull nomic-embed-text` (or `mxbai-embed-large`, `bge-m3`) |
| **`voyage-4-nano` local server** | Local CPU/MPS/CUDA | Local | `docker compose up -d embed` OR run natively (see §5) |

Defaults to suggest:
- User mentions "private code" / "no egress" → Ollama or local `voyage-4-nano`.
- User wants the highest quality and is OK egressing names+signatures → **Voyage cloud**.
- Apple Silicon user who wants fast local + best code quality → **native `voyage-4-nano` with `EMBED_DEVICE=mps`**.
- User is unsure → start with **lexical-only**; they can flip the env vars later without re-indexing.

### Q4 — Which agent(s) should be wired up?

Pick all that apply — RepoSkein is MCP-stdio, so it works with any MCP-capable agent.

| Agent | Config location | Schema key |
|---|---|---|
| **Claude Code** | `<repo>/.mcp.json` | `mcpServers` |
| **OpenCode** (omo runs on top) | `~/.config/opencode/opencode.json` (global) or `<repo>/opencode.json` (per-project) | `mcp` (NOT `mcpServers`) |
| **Cursor** | `<repo>/.cursor/mcp.json` | `mcpServers` |
| **Codex** | `~/.config/codex/config.json` | `mcpServers` |
| **Continue** | `~/.continue/config.json` → `experimental.modelContextProtocolServers[]` | array of objects |
| **Cline / Roo / Kilo / …** | `<repo>/.cline/mcp.json` (similar per-agent dirs) | `mcpServers` |
| **Generic / unknown agent** | Write `<repo>/.mcp.json` (broadest compat) and tell them the env vars + command. | `mcpServers` |

Templates in §6.

### Q5 — What in `.reposkein/` goes into git?

Not a question to ask; `init` sets it up. **Commit** `meta.json`, `config.toml`, `.gitignore`, `.gitattributes` and `summaries/` (the summaries your agents author, which nothing can regenerate). **Do not commit** `nodes.jsonl` / `edges.jsonl` — `.reposkein/.gitignore` already excludes them. They are a pure function of the working tree, so every clone rebuilds them in seconds, and committing them would make every branch that touches code conflict with every other one. `local/` is ignored too. Summaries are sharded into `summaries/<xx>.jsonl` so two branches rarely write the same file — see §4.2.

### Q6 — Install the cross-agent navigation skills?

`reposkein-graph-rag` (teaches the agent **when** to use each tool) and `reposkein-setup` (teaches it how to install + verify) ship as portable [Agent Skills](https://skills.sh). They're independent of the MCP server and improve tool-use quality across 70+ agents.

```sh
npx skills add reposkein/reposkein --all      # both skills
```

Run **at the workspace root** (not inside a sub-repo) — `npx skills` discovers every per-agent skills dir (`.claude/skills/`, `.cursor/skills/`, `.continue/skills/`, `.opencode/skills/`, etc.) at that location and writes universal SKILL.md + per-agent symlinks. Re-run after adding new agent tooling.

---

## 2. Prerequisites check

```sh
node --version           # ≥ 18
git --version            # any modern
docker --version         # optional (only if user picked Neo4j or Docker embed-server)
python3 --version        # optional (only if user picked native embed-server) — needs ≥3.11
uv --version             # optional (recommended for native embed-server venv)
rg --version             # optional (only for running Track 1 benchmark)
```

Platform support: macOS (Apple Silicon), Linux (x64/arm64), Windows (x64). Intel Macs are not built — use `REPOSKEIN_INDEXER_BIN` with a from-source build.

---

## 3. Install the MCP server + indexer

### 3.1 Single global install (recommended for workspaces with many repos)

```sh
npm install -g @reposkein/mcp
which reposkein-mcp        # confirm
```

`postinstall` fetches the platform-specific `reposkein-indexer` binary for the **exact mcp version** from GitHub Releases — keep versions in lockstep if you ever pin manually.

The bundled binary lives at:
```
$(npm root -g)/@reposkein/mcp/bin/reposkein-indexer
```
Export `REPOSKEIN_INDEXER_BIN` to that path when you need the indexer directly (Neo4j `load`, see §4.3).

### 3.2 Per-repo (no global install, npx-only)

Skip §3.1 — every command becomes `npx @reposkein/mcp <subcommand>` and downloads the binary into `<repo>/node_modules/@reposkein/mcp/bin/` on first run.

---

## 4. Initialize each git repo

For each repo the user wants navigable:

```sh
cd /path/to/repo
reposkein-mcp init                    # or: npx @reposkein/mcp init
```

This:
1. Verifies/fetches the platform indexer binary.
2. Installs git hooks (`pre-commit` re-indexes the local graph, staging nothing; `post-merge` reloads Neo4j if configured).
3. Installs the `reposkein-graph-rag` skill into `.claude/skills/` (no-op on agents that ignore `.claude/`).
4. Walks the tree with Tree-sitter → writes deterministic `.reposkein/nodes.jsonl` + `.reposkein/edges.jsonl` + `.reposkein/meta.json`, plus a `.reposkein/.gitignore` that keeps the two derived files out of git.
5. **Prints an MCP config block** for the user to paste into their agent — you (the agent) should pick the right schema (§6) and write it directly.

Verify:

```sh
reposkein-mcp doctor .       # ✓ binary  ✓ indexed (N nodes)  ✓ ready
git add .reposkein/meta.json .reposkein/config.toml .reposkein/.gitignore .reposkein/.gitattributes
git commit -m "add RepoSkein config"
```

`nodes.jsonl` and `edges.jsonl` are deliberately absent from that `git add`: they are derived, git-ignored, and rebuilt on demand. `.reposkein/summaries/` appears once an agent writes its first summary; commit it then (§4.2).

### 4.1 Multi-repo workspaces

Run §4 once **per git sub-repo**. Don't try to run it in the workspace root if the root isn't itself a git repo — RepoSkein needs git for hooks and for `get_temporal_context`.

Federation is derived at query time: when an MCP server points at one repo and a sibling/nested repo also has `.reposkein/`, passing `federated: true` to `semantic_find` / `get_context_profile` / `impact` stitches them via `FEDERATES_TO` edges (load-time only — never committed).

### 4.2 Merge behaviour for `.reposkein/`

There is no `.gitattributes` rule for `nodes.jsonl` / `edges.jsonl`, and `init --hooks` removes any an older RepoSkein installed. Those files are **not committed** — a merge driver has nothing left to resolve, and the one it used to declare never ran where it mattered.

That is the load-bearing fact for everything below: **a forge computes mergeability in a bare repository, where a tree-level `.gitattributes` is never consulted.** Verified with `git merge-tree --write-tree` against a bare clone — `git check-attr merge` reports `union` in a worktree and `unspecified` in the bare repo. So `merge=union` does not save you on GitHub or GitLab, and neither does a custom driver. See `docs/migrations/2026-08-06-stop-committing-derived-graph.md`.

#### What is committed

| Path | Committed | Why |
|---|---|---|
| `.reposkein/summaries/<xx>.jsonl` | **yes** | Agent-authored prose. Nothing can regenerate it. |
| `.reposkein/meta.json`, `config.toml` | yes | Small, hand-edited, stable. |
| `.reposkein/.gitignore`, `.gitattributes` | yes | The rules themselves. |
| `.reposkein/nodes.jsonl`, `edges.jsonl` | no | Derived; rebuilt from source in seconds. |
| `.reposkein/local/` | no | Per-machine scratch (sidecars, conflicts, deltas). |

#### How the summary shards avoid conflicts

Merge smoothness here comes from **file granularity**, not from a merge strategy — the same answer the decision log uses.

A summary for node `<id>` lands in `.reposkein/summaries/<xx>.jsonl`, where `<xx>` is the first two hex characters of `BLAKE3(<id>)`. That is up to 256 small files. Two branches summarising different code almost always write different files, so their commits touch disjoint paths and a forge has nothing to conflict on. (Hashing rather than slicing the id matters: `rs1:<repo>:func:…` ids share long prefixes, so a prefix-based shard would put a whole repo in one file.)

Inside a shard, `index` writes canonical bytes: one record per line, `id` first then sorted keys, sorted by id, LF-terminated, written via a temp file and a rename. The same tree produces the same bytes on every machine — CI enforces it.

Four properties keep the remaining collisions harmless:

1. **`.reposkein/.gitattributes` declares `summaries/*.jsonl merge=union`.** This helps *local* merges and rebases only — which is exactly where a human hits the conflict by hand. It is scoped inside `.reposkein/`, so it never collides with your own rules.
2. **Readers dedupe by node id.** A union merge that keeps both sides' lines just produces a duplicate, and both the indexer and the MCP server collapse it.
3. **Divergence resolves deterministically, by one of two rules.** Between two records found in the *same* place — two lines of one merged shard, or two agents' sidecars — only content can decide: the newer `summary_at` wins, and ties break on raw-line byte order. When a whole *newer source* is folded onto an older one (your sidecars onto the committed shards), provenance is real, so the newer source wins unless it is strictly older by `summary_at`. That second rule is why re-summarising a node you already summarised today still takes — `summary_at` is day-precision, so it would otherwise tie — and why a months-old local record can never clobber a teammate's newer one. Every machine picks the same winner either way.
4. **The loser is never destroyed.** It is appended to `.reposkein/local/conflicts.jsonl`, and `reposkein-mcp doctor` reports it so a human can re-write anything worth keeping.

A shard left with literal `<<<<<<<` markers is also survivable: both readers skip marker lines with a warning, and the next `index` rewrites the file cleanly.

#### Staging the shards

The pre-commit hook stages nothing by default; it runs `reposkein-indexer stage-summaries`, which prints a hint when authored shards changed and were left out of the commit. Newly-initialized repos get `[hooks] stage_summaries = true` in `.reposkein/config.toml`, which stages them automatically instead. Existing repos keep hint-only behaviour until someone adds that section by hand — an upgrade must not start putting new content into people's commits.

#### Upgrading an existing repo

Run `reposkein-mcp index .` once. It folds `.reposkein/summaries.jsonl` into the shards and retires the file; commit the result (one deletion, N small additions). Both files are read during this release, so a teammate still on the old indexer loses nothing — their re-created `summaries.jsonl` is folded in on your next index. Then run `reposkein-indexer init --hooks .` to drop any stale `merge=` line from your root `.gitattributes`.

A repo old enough to have summaries living inside a once-committed `nodes.jsonl` gets those harvested too, on the **first** index only. That harvest is deliberately one-shot per working tree, recorded by `.reposkein/local/.legacy-nodes-harvested`: `nodes.jsonl` is git-ignored, so it survives `git checkout`, and mining it for authored prose on every index would write branch A's summaries into branch B's shards — reintroducing exactly the cross-branch churn the sharding removes. After that first run, steady state reads committed shards and per-agent sidecars only. Delete the marker only if you know the checkout still holds an un-migrated `nodes.jsonl`.

If your repo-root `.gitignore` has a blanket rule over `.reposkein/`, add a negation for the shards or they are silently never committed:

```
**/.reposkein/*
!**/.reposkein/summaries/
```

`reposkein-mcp doctor` checks for exactly this.

#### Bulk re-summarization

A sweep that rewrites many summaries at once touches many shards at once, which is the one workload sharding does *not* smooth over. Run those through a single serialized job on `main` rather than from a branch — see `docs/policies/bulk-resummarization-sweeps.md`.

### 4.3 Neo4j load (only if §1-Q2 = Neo4j)

After §4 succeeds for a repo:

```sh
export NEO4J_URI=neo4j://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=<password>          # 'reposkeintest' for the bundled compose
export REPOSKEIN_INDEXER_BIN="$(npm root -g)/@reposkein/mcp/bin/reposkein-indexer"
"$REPOSKEIN_INDEXER_BIN" load .           # imports nodes.jsonl + edges.jsonl into Neo4j
```

CI invariant: `load → export` is byte-identical to the source JSONL — if it ever isn't, that's a bug, file it.

Repeat per repo (each repo's `repo_id` is distinct, so they coexist in the same Neo4j instance).

---

## 5. Embedding server (only if §1-Q3 = local server)

### 5.1 Docker (any OS, no GPU on Apple Silicon)

```sh
# From the repo root of the user's reposkein checkout, OR with `docker run`:
docker run -d --name reposkein-embed -p 127.0.0.1:8080:8080 \
  -v reposkein-hf:/root/.cache/huggingface \
  ghcr.io/reposkein/reposkein-embed:latest
curl http://127.0.0.1:8080/health
```

CPU-only inside Docker even on Apple Silicon (Docker cannot reach Metal/MPS).

### 5.2 Native (Apple Silicon mps — fastest on Mac)

```sh
cd /path/to/reposkein/embed-server   # requires a clone of this repo for app.py + requirements.txt
uv venv --python 3.11 .venv
uv pip install --python ./.venv/bin/python -r requirements.txt
EMBED_DEVICE=mps EMBED_MODEL=voyageai/voyage-4-nano EMBED_DIMS=1024 \
  ./.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8080
```

**Known gotcha:** `voyage-4-nano` ships a custom Qwen3 implementation that breaks against `transformers >= 5.0` (`TypeError: create_causal_mask() got an unexpected keyword argument 'input_embeds'`). The pinned `requirements.txt` keeps `transformers >=4.51,<5`. If you reinstall manually, keep the same pin.

Run as a background service via launchd / systemd / `nohup uvicorn … &` — the model is loaded lazily on the first `/v1/embeddings` call (warming takes ~10–30 s on first use, then cached).

---

## 6. Wire up the agent(s)

The MCP server runs over stdio. The command is `reposkein-mcp` (global) or `npx @reposkein/mcp` (no global). Env vars:

| Var | Required | Notes |
|---|---|---|
| `REPOSKEIN_REPO_PATH` | **Yes** for repo-scoped tools | Absolute path. One MCP server entry = one repo path. |
| `REPOSKEIN_STORE` | No | `auto` (default — JSONL if present else Neo4j), `jsonl`, `neo4j`. |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | If `REPOSKEIN_STORE=neo4j` or `auto`-with-Neo4j | — |
| `REPOSKEIN_EMBED_PROVIDER` | If §1-Q3 ≠ off | `voyage`, `http`, or unset for lexical-only. |
| `VOYAGE_API_KEY` | If `REPOSKEIN_EMBED_PROVIDER=voyage` | — |
| `REPOSKEIN_EMBED_URL` / `REPOSKEIN_EMBED_MODEL` / `REPOSKEIN_EMBED_DIMS` | If `REPOSKEIN_EMBED_PROVIDER=http` | `DIMS` MUST equal the server's output dim or cosine scoring is skipped. |
| `REPOSKEIN_INDEXER_BIN` | Only on unsupported platforms | Override binary path. |

### 6.1 Claude Code (and any `.mcp.json`-reading agent)

Write `<repo>/.mcp.json`:

```jsonc
{
  "mcpServers": {
    "reposkein": {
      "command": "reposkein-mcp",
      "env": {
        "REPOSKEIN_REPO_PATH": "/absolute/path/to/repo",
        "REPOSKEIN_STORE": "auto",
        "NEO4J_URI": "neo4j://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "reposkeintest",
        "REPOSKEIN_EMBED_PROVIDER": "http",
        "REPOSKEIN_EMBED_URL": "http://127.0.0.1:8080/v1/embeddings",
        "REPOSKEIN_EMBED_MODEL": "voyage-4-nano",
        "REPOSKEIN_EMBED_DIMS": "1024"
      }
    }
  }
}
```

Drop any block whose feature the user didn't enable. `REPOSKEIN_REPO_PATH` is the only required key.

> **Gitignore `.mcp.json` / `opencode.json`.** They hold absolute machine paths and a local `NEO4J_PASSWORD`, so they are per-machine and must not be committed. `reposkein-mcp init` adds them to `.gitignore` for you; if you write them by hand, do the same. What is shared from `.reposkein/` is `meta.json`, `config.toml`, `.gitignore`, `.gitattributes`, `summaries/` and `decisions/` (§4.2).

### 6.2 OpenCode (+ omo)

OpenCode uses `mcp` (not `mcpServers`) and a `type` field. Edit `~/.config/opencode/opencode.json` for global servers, or write `<repo>/opencode.json` for per-project. Multiple repos → multiple named entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "reposkein": {
      "type": "local",
      "command": ["reposkein-mcp"],
      "environment": {
        "REPOSKEIN_REPO_PATH": "/absolute/path/to/repo",
        "REPOSKEIN_STORE": "auto",
        "NEO4J_PASSWORD": "reposkeintest"
      },
      "enabled": true
    }
  }
}
```

`omo` (Oh-My-OpenAgent) sits on top of OpenCode for agent/model routing — it reads OpenCode's MCP config, so this is the only file you touch for both.

For multi-repo workspaces under OpenCode, define one server **per repo** under distinct names (`reposkein-backend`, `reposkein-ui`, …) since `REPOSKEIN_REPO_PATH` is static per entry.

### 6.3 Cursor

```jsonc
// <repo>/.cursor/mcp.json
{
  "mcpServers": {
    "reposkein": {
      "command": "reposkein-mcp",
      "env": { "REPOSKEIN_REPO_PATH": "/absolute/path/to/repo" }
    }
  }
}
```

### 6.4 Codex

```jsonc
// ~/.config/codex/config.json
{
  "mcpServers": {
    "reposkein": {
      "command": "reposkein-mcp",
      "args": [],
      "env": { "REPOSKEIN_REPO_PATH": "/absolute/path/to/repo" }
    }
  }
}
```

### 6.5 Continue

```jsonc
// ~/.continue/config.json (top-level)
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "reposkein-mcp",
          "env": { "REPOSKEIN_REPO_PATH": "/absolute/path/to/repo" }
        }
      }
    ]
  }
}
```

### 6.6 Cline / Roo / Kilo / Continue-fork / generic

99% of MCP-aware agents read either `.mcp.json` (Claude Code schema, often in a per-agent dir) OR an `mcpServers` block in their global config. When in doubt, write **both** `<repo>/.mcp.json` AND tell the user the env vars + command, and they'll wire whatever agent they use.

---

## 7. Final verification

After everything is configured, restart the user's agent (most agents only read MCP config at startup), then ask the agent to run:

1. **`reposkein-mcp doctor .`** in each indexed repo — expects `✓ binary  ✓ indexed (N nodes)  ✓ ready`.
2. **A `semantic_find` call** through the MCP tool — should return ranked candidates with one-line summaries.
3. **A `get_context_profile` call** on one of those candidates — should return caller/callee neighborhood as prose.
4. **If Neo4j:** open <http://localhost:7474> and run `MATCH (n) RETURN count(n)` — should match `meta.json` node counts (cumulative across loaded repos).
5. **If embedding server:** `curl http://127.0.0.1:8080/health` returns `{"status":"ok",...}`.

---

## 8. Cheat sheet (copy-paste, agent-facing)

```sh
# 1. Global install
npm install -g @reposkein/mcp

# 2. Per repo
cd /path/to/repo
reposkein-mcp init
reposkein-mcp doctor .
git add .reposkein/meta.json .reposkein/config.toml .reposkein/.gitignore && git commit -m "add RepoSkein config"

# 3. (Optional) Neo4j
docker compose --profile neo4j up -d           # from a reposkein checkout
export REPOSKEIN_INDEXER_BIN="$(npm root -g)/@reposkein/mcp/bin/reposkein-indexer"
NEO4J_PASSWORD=reposkeintest "$REPOSKEIN_INDEXER_BIN" load .

# 4. (Optional) Local embed-server, Apple Silicon mps
cd /path/to/reposkein/embed-server
uv venv --python 3.11 .venv
uv pip install --python ./.venv/bin/python -r requirements.txt
EMBED_DEVICE=mps ./.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8080 &

# 5. Cross-agent skills (run at workspace root)
npx skills add reposkein/reposkein --all
```

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `REPOSKEIN_REPO_PATH (or REPOSKEIN_REPO_ID) must be set` | The env var is missing from the MCP server entry. | Add it to the agent's MCP config (§6). |
| `npm install -g @reposkein/mcp` succeeds but no `reposkein-indexer` binary | Postinstall fetch failed. | Re-run `npm install -g @reposkein/mcp --force` with network access. Else point `REPOSKEIN_INDEXER_BIN` at a [from-source build](https://github.com/reposkein/reposkein#build-from-source). |
| `TypeError: create_causal_mask() got an unexpected keyword argument 'input_embeds'` | Native embed-server with `transformers >= 5.0`. | `uv pip install 'transformers>=4.51,<5'` and restart. |
| Neo4j gated tests skipping or `MATCH (n) RETURN count(n)` is 0 | Indexer never ran `load`. | Run `reposkein-indexer load .` once per repo. |
| `semantic_find` returns nothing despite a real query | Index empty (no supported languages in the repo). | Check supported languages in the [README](../README.md#supported-languages). |
| Agent doesn't see the tools | Agent not restarted after MCP config change, OR config in the wrong file for that agent. | Restart agent; double-check §6 file/schema. |
| Federation not stitching cross-repo edges | `federated: true` not passed, OR sibling repos missing `.reposkein/`. | Pass the flag; index every repo in the workspace. |

---

## 10. The agent-facing one-liner the user can paste

When the user wants to hand this off without copying the whole document, they can paste **just this prompt** plus a link to this file:

> Install RepoSkein in this workspace. Read `docs/INSTALL.md` (or `https://github.com/reposkein/reposkein/blob/main/docs/INSTALL.md`), walk me through the question tree in §1, then execute §2 onward. If anything fails, troubleshoot via §9 — don't silently skip steps. Confirm with `reposkein-mcp doctor .` per repo and a `semantic_find` smoke test before claiming done.

---

## 11. Host a shareable link (optional)

Want a durable link to the constellation viewer (for a README, a PR, or a
teammate without RepoSkein installed) instead of `reposkein-mcp view`'s local
server? `reposkein-mcp view --export` produces a self-contained static site
(no server, works from `file://`). `reposkein-mcp init --ci` writes a GitHub
Actions workflow that publishes it to GitHub Pages on every push.

**Read [`docs/HOSTING.md`](./HOSTING.md) before enabling this** — it covers
GitHub Pages' public-by-default visibility and internal-host alternatives.

