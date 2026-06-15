# RepoSkein Agent Skills

Cross-agent [Agent Skills](https://skills.sh) for RepoSkein — install with one
command into Claude Code, Cursor, Codex, and other compatible agents.

## Skills

- **`reposkein-setup`** — installs RepoSkein in a repo and verifies it's running
  (binary → `.reposkein/` index → MCP server reachability). Start here.
- **`reposkein-graph-rag`** — navigates the RepoSkein code graph (callers,
  callees, impact, summaries). Use once RepoSkein is set up.

## Install

```bash
# both skills
npx skills add reposkein/reposkein --all

# or one
npx skills add reposkein/reposkein --skill reposkein-setup
npx skills add reposkein/reposkein --skill reposkein-graph-rag
```

The skills are *procedural knowledge* — they tell your agent how to install,
verify, and drive RepoSkein. The runtime itself is the **`@reposkein/mcp`** npm
package + the native indexer (the `reposkein-setup` skill installs them).
