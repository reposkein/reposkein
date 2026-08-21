# Neo4j backend

For humans.

Moved out of the [README](../README.md) so the front door stays short.

The zero-infra JSONL store is the default. Neo4j is an optional projection for very large graphs and raw Cypher at scale:

```sh
docker compose --profile neo4j up -d          # from the repo root
NEO4J_PASSWORD=reposkeintest reposkein-indexer load .
```
Then set `REPOSKEIN_STORE=neo4j` + the `NEO4J_*` env vars on the MCP server. (`REPOSKEIN_STORE=auto`, the default, uses JSONL when present and falls back to Neo4j only if configured.)

## See also

- [`INSTALL.md` §2](INSTALL.md) — the agent-facing decision tree for JSONL vs Neo4j, including env vars for a non-Docker Neo4j instance.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — why JSONL, not Neo4j, is the source of truth.
