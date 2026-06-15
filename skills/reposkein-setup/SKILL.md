---
name: reposkein-setup
description: >
  Installs and verifies RepoSkein (the deterministic code-graph MCP server) in
  the current repository. Use when an agent wants RepoSkein's structural
  navigation but the tools are missing, error with "REPOSKEIN_REPO_PATH", or the
  repo has no .reposkein/ directory — i.e. set RepoSkein up and confirm it runs.
---

# RepoSkein Setup & Health Check

Goal: get RepoSkein actually serving in THIS repo, then confirm it before relying
on it. RepoSkein has three moving parts — the **indexer binary**, the committed
**`.reposkein/` graph**, and the **MCP server** registered in your agent. This
skill walks all three and verifies each.

## 1. Check current state first

Run the health check (it needs nothing but Node + the package):

```bash
npx -y @reposkein/mcp doctor .
```

Read the report. `✓ indexer binary` and `✓ repo indexed` are the prerequisites.
If both pass, skip to step 4 (verify the server). Otherwise continue.

## 2. Install + index (if doctor reported ✗)

```bash
npx -y @reposkein/mcp init .       # fetches the indexer, installs git hooks + the navigation skill
reposkein-indexer index .          # builds .reposkein/ (or ask the agent to call init_cpg_skeleton)
git add .reposkein && git commit -m "chore: add RepoSkein graph"
```

Re-run `npx -y @reposkein/mcp doctor .` until the binary + index checks are `✓`.

## 3. Register the MCP server (host-specific — pick YOUR agent)

A skill cannot register an MCP server for you; each agent stores MCP config
differently. Add the RepoSkein server with `REPOSKEIN_REPO_PATH` set to this repo:

- **Claude Code** — add to `.mcp.json` at the repo root (or `claude mcp add`):
  ```json
  { "mcpServers": { "reposkein": { "command": "reposkein-mcp", "env": { "REPOSKEIN_REPO_PATH": "/abs/path/to/repo" } } } }
  ```
- **Cursor** — add the same server block to `.cursor/mcp.json`.
- **Codex / other MCP hosts** — add an stdio server: command `reposkein-mcp`,
  env `REPOSKEIN_REPO_PATH=/abs/path/to/repo`.

Then **restart / reload the agent** so it picks up the new server.

## 4. Confirm the server is actually running

The doctor checks prerequisites but cannot see your agent's MCP wiring — verify
that by USING a tool. Call `get_context_profile` with a function name you know
exists in this repo:

- A normal profile (callers/callees) → RepoSkein is live. Done.
- An error mentioning `REPOSKEIN_REPO_PATH` → the env isn't set on the server; fix
  the config in step 3 and restart.
- "tool not found" / no `get_context_profile` → the server isn't registered yet;
  redo step 3 and restart the agent.

Once verified, use the **reposkein-graph-rag** skill for navigation (callers,
callees, impact, summaries). Do not guess dependencies or grep when the graph
can answer structurally.
