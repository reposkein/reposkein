# Container image for MCP server registries (e.g. Glama) to start the RepoSkein
# MCP server and verify it responds to introspection (initialize + tools/list).
#
# The server registers all of its tools at startup, so introspection succeeds
# even without a repository configured (the tools return a clear error at call
# time until REPOSKEIN_REPO_PATH is set). For real use, mount your repo and set
# REPOSKEIN_REPO_PATH — see the README quickstart.
FROM node:24-slim

# Installs @reposkein/mcp; its postinstall fetches the prebuilt reposkein-indexer
# binary for the container platform (graceful — install still succeeds offline).
RUN npm install -g @reposkein/mcp@latest

# Stdio MCP server (the same binary `reposkein-mcp` the README configures).
ENTRYPOINT ["reposkein-mcp"]
