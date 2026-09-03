# Kubernetes

For humans.

RepoSkein's default is JSONL on disk: no cluster, no database, no embeddings, nothing to deploy. These manifests are for the two **optional** supporting services, and neither is required to use RepoSkein.

The MCP server itself is **not** deployed here. It runs over stdio, launched by your agent on your machine. What goes on the cluster is the services it talks to.

## What Kubernetes actually buys you

Being precise, because it is easy to oversell:

**It does not use less memory.** The same model weights and the same JVM heap cost the same wherever they run.

**It enforces the budget.** `resources.requests` and `limits` are the same lever as the `mem_limit` in `docker-compose.yml`, but the scheduler refuses to place a pod it cannot fit, and an OOM kills one container. It cannot page out the machine you are typing on.

**It moves the work off your workstation.** This is the real win. On macOS and Windows the embedding server runs CPU-only inside a Linux VM whose memory is reserved from the host — stock Docker Desktop gives it about 8 GiB, shared with Neo4j, competing with your editor. On a cluster it runs on a node with real headroom, optionally with a GPU, and your machine keeps its RAM.

If you are staying on one laptop, `docker compose` is the simpler answer and the memory story is identical. See [`INSTALL.md`](INSTALL.md).

## Embedding server

```sh
kubectl apply -f deploy/k8s/embed.yaml
kubectl -n reposkein rollout status deploy/reposkein-embed   # first start downloads the model
kubectl -n reposkein port-forward svc/reposkein-embed 8080:8080
```

Then, on the MCP server:

```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:8080/v1/embeddings
REPOSKEIN_EMBED_MODEL=voyage-4-nano
REPOSKEIN_EMBED_DIMS=1024          # must equal EMBED_DIMS in the manifest
```

No code path changes — the `http` provider does not know or care that the other end is in a cluster.

The first start pulls ~693 MB of weights onto the volume, which is why the pod carries a **startup probe** with a ten-minute budget: it holds the liveness and readiness probes off entirely rather than making them permanently lenient. `kubectl -n reposkein logs deploy/reposkein-embed` shows the download.

Request limits (`EMBED_MAX_BATCH_ITEMS`, `EMBED_MAX_CONCURRENCY`, and the rest) are set in the manifest to the same values as the compose file, deliberately — one set of numbers, not two that drift. `GET /health` reports whatever is live.

## Neo4j

Optional, and most users never need it. Create the secret first — there is no password literal in the manifest:

```sh
kubectl create namespace reposkein
kubectl -n reposkein create secret generic reposkein-neo4j \
  --from-literal=auth="neo4j/$(openssl rand -base64 24 | tr -d /=+)"
kubectl apply -f deploy/k8s/neo4j.yaml
kubectl -n reposkein port-forward svc/reposkein-neo4j 7687:7687
```

```sh
REPOSKEIN_STORE=neo4j
NEO4J_URI=neo4j://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=…
```

Populate it with `reposkein-indexer load .`, which writes in bounded chunks (`REPOSKEIN_IMPORT_CHUNK_SIZE`, default 5,000 rows per transaction).

Heap, page cache and transaction ceilings are set explicitly in the manifest for the same reason as in compose: the Neo4j image pins only the page cache, so an unset heap falls to JVM ergonomics at 25% of whatever the container can see.

## Sizing

| Workload | request | limit |
| --- | --- | --- |
| `reposkein-embed` | 2Gi / 1 CPU | 3Gi / 4 CPU |
| `reposkein-neo4j` | 1500Mi / 0.5 CPU | 2Gi / 2 CPU |

Both are one replica. The embedding server loads the model per process, so a second replica is another ~1.4 GB of weights — scale out only after measuring that you need to.

## See also

- [`EMBEDDINGS.md`](EMBEDDINGS.md) — the embedding tiers, and the client-side batch budget.
- [`NEO4J.md`](NEO4J.md) — the Neo4j backend and its memory settings.
- [`HOSTING.md`](HOSTING.md) — publishing the constellation viewer.
