# Neo4j backend

For humans.

Moved out of the [README](../README.md) so the front door stays short.

The zero-infra JSONL store is the default. Neo4j is an optional projection for very large graphs and raw Cypher at scale:

```sh
docker compose --profile neo4j up -d          # from the repo root
NEO4J_PASSWORD=reposkeintest reposkein-indexer load .
```
Then set `REPOSKEIN_STORE=neo4j` + the `NEO4J_*` env vars on the MCP server. (`REPOSKEIN_STORE=auto`, the default, uses JSONL when present and falls back to Neo4j only if configured.)

## Memory

**Check your Docker VM before starting anything.** On macOS and Windows, Docker runs a Linux VM whose memory is reserved from the host — a 32 GB laptop does not mean a 32 GB VM. The stock Docker Desktop allocation is around 8 GiB with 1 GiB of swap, and Neo4j and the embedding server share it. Docker Desktop → Settings → Resources shows the figure; raise it to at least **6 GiB** if you run both, and give the embedding server room by running Neo4j alone when you can.

The bundled compose file bounds both services (`mem_limit`, explicit heap and page cache), so nothing here auto-sizes off the VM any more. If you run **your own** Neo4j, set the heap explicitly — the official image pins only the page cache, and an unset heap falls to JVM ergonomics at 25% of whatever RAM the container can see:

```sh
NEO4J_server_memory_heap_initial__size=1G
NEO4J_server_memory_heap_max__size=1G
NEO4J_server_memory_pagecache_size=512M
```

RepoSkein's graph is small — a 200k-node repository is roughly 130 MB on disk — so these are generous. For a dedicated machine, generate your own numbers with `neo4j-admin server memory-recommendation --memory=<size> --docker`.

`reposkein-indexer load` writes in bounded chunks — 5,000 rows per transaction by default, one transaction per chunk — so a large graph never builds a single payload the server has to hold whole. Lower it if your instance is tight:

```sh
REPOSKEIN_IMPORT_CHUNK_SIZE=1000 reposkein-indexer load .
```

## See also

- [`INSTALL.md` §2](INSTALL.md) — the agent-facing decision tree for JSONL vs Neo4j, including env vars for a non-Docker Neo4j instance.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — why JSONL, not Neo4j, is the source of truth.
