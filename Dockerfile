# Container image for MCP server registries (e.g. Glama) to start the RepoSkein
# MCP server and verify it responds to introspection (initialize + tools/list).
#
# The server registers all of its tools at startup, so introspection succeeds
# even without a repository configured (the tools return a clear error at call
# time until REPOSKEIN_REPO_PATH is set). For real use, mount your repo and set
# REPOSKEIN_REPO_PATH — see the README quickstart.
FROM node:24-slim

# Pin the published version for reproducible builds; defaults to the latest.
# Build a specific version with `--build-arg MCP_VERSION=0.2.2`.
ARG MCP_VERSION=latest

# Installs @reposkein/mcp; its postinstall fetches the prebuilt reposkein-indexer
# binary for the container platform (graceful — install still succeeds offline).
RUN npm install -g @reposkein/mcp@${MCP_VERSION}

# Build-time start gate: the registry's exact use case is "launch reposkein-mcp
# and speak MCP to it", so make THAT a build gate. Pipe an `initialize` frame
# into the installed bin (invoked by name — relies on the shebang, exactly as a
# registry launches it) and require a JSON-RPC `"result"`. If the published bin
# can't start (e.g. a missing shebang as in 0.2.0, or a broken entry guard as in
# 0.2.1), the image FAILS TO BUILD instead of shipping a dead server.
RUN OUT="$(printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"docker-build-smoke","version":"0"}}}\n' | reposkein-mcp 2>/dev/null)"; \
    echo "initialize response: ${OUT}"; \
    echo "${OUT}" | grep -q '"result"' || { echo "FATAL: reposkein-mcp did not answer MCP initialize at build time" >&2; exit 1; }; \
    echo "OK: reposkein-mcp answers MCP initialize"

# Stdio MCP server (the same binary `reposkein-mcp` the README configures).
ENTRYPOINT ["reposkein-mcp"]
