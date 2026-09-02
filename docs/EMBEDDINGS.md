# Semantic embeddings

For humans.

Moved out of the [README](../README.md) so the front door stays short.

By default `semantic_find` is **deterministic and lexical** (BM25F — zero-infra, no keys). You can opt into a **hybrid** tier (lexical + embedding cosine, fused via RRF) for fuzzier queries. It's **default-off**, vectors are cached in `.reposkein/local/embeddings/` (gitignored, never committed), and it **falls back to lexical** automatically on any error. Set env vars on the MCP server and **pick one**:

## A) Voyage AI — cloud, easiest, best for code

[Get a key](https://dashboard.voyageai.com/), then:
```sh
REPOSKEIN_EMBED_PROVIDER=voyage
VOYAGE_API_KEY=pa-...
# optional: REPOSKEIN_EMBED_MODEL=voyage-code-3   # default — code-specialized
```
> Sends document strings (qualified names, signatures, summaries) to Voyage's API. Use B or C if you can't egress code.

## B) Ollama — local, off-the-shelf, no key

```sh
ollama pull nomic-embed-text     # 768-dim (or mxbai-embed-large=1024, bge-m3=1024)
```
```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:11434/v1/embeddings
REPOSKEIN_EMBED_MODEL=nomic-embed-text
REPOSKEIN_EMBED_DIMS=768          # must match the model
```

## C) Voyage's open model, self-hosted — offline + Voyage quality

`voyage-4-nano` (Apache-2.0) is a custom Qwen3-based model Ollama can't run, so RepoSkein ships a prebuilt server. The image is **published to GHCR — public and multi-arch (amd64/arm64)** — so there's nothing to build:

```sh
docker run -p 8080:8080 -v reposkein-hf:/root/.cache/huggingface \
  ghcr.io/reposkein/reposkein-embed          # auto-picks your architecture; first run downloads the model
```
```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:8080/v1/embeddings
REPOSKEIN_EMBED_MODEL=voyage-4-nano
REPOSKEIN_EMBED_DIMS=1024         # must equal the server's EMBED_DIMS
```

Everything stays on your machine. The image is **CPU-only and runs with no NVIDIA GPU** on Apple Silicon / ARM unified-memory, x64 Linux, and Windows (CI builds + smoke-tests both arches). Docker can't use Apple's Metal/MPS — for that, run the server natively with `EMBED_DEVICE=mps`. Full details (root `docker compose up`, GPU, other models): [`../embed-server/README.md`](../embed-server/README.md).

> `REPOSKEIN_EMBED_DIMS` on the client **must match** the model's output dimension, or cosine scoring is skipped.

## Batch size (memory)

Embedding a repository for the first time is the one moment RepoSkein does bulk work. Requests are **batched**, and each batch is written to the cache as it lands — so an interrupted first run resumes rather than starting over.

Each provider declares what one request may carry (Voyage: 1000 texts / 120k tokens; the local `http` provider: 32 texts / 8192 tokens, sized for a single-model CPU server). Lower either if the machine is tight — these can only tighten a provider's limit, never raise it:

```sh
REPOSKEIN_EMBED_MAX_BATCH_ITEMS=16     # texts per request
REPOSKEIN_EMBED_MAX_BATCH_TOKENS=4096  # estimated tokens per request
```

Peak memory *per request* tracks one batch rather than the size of the repository. If a first run is being killed by the OOM killer, halve these before anything else. (The vector cache itself is still held whole in memory while it is read and written — that is a separate piece of work.)

## See also

- [`INSTALL.md` §3](INSTALL.md) — the agent-facing decision tree (off / cloud / local) with defaults to suggest.
- [`../embed-server/README.md`](../embed-server/README.md) — the local embedding server package.
