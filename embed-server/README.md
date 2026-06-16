<div align="center">
<img src="https://capsule-render.vercel.app/api?type=soft&color=0:070A12,50:2DD4BF,100:F2B84B&height=90&section=header&text=embed-server&fontColor=EAE7DC&fontSize=40" width="100%" alt="reposkein embed-server" />

<sub><a href="https://github.com/reposkein/reposkein">← RepoSkein</a> · <a href="https://github.com/reposkein/reposkein#optional-semantic-embeddings">Embeddings docs</a></sub>

</div>

# reposkein-embed-server

**Contents:** [Run it](#run-it-one-command) · [Platforms](#platforms--hardware-no-nvidia-gpu-required) · [Point RepoSkein at it](#point-reposkein-at-it) · [Smoke test](#smoke-test) · [Configuration](#configuration) · [Run without Docker](#run-without-docker)

A **ready-to-go local embedding service** for RepoSkein's optional semantic
embeddings (`semantic_find`'s hybrid tier). It serves an OpenAI-compatible
`POST /v1/embeddings` endpoint backed by a SentenceTransformer model — by
default **Voyage AI's open-weight [`voyage-4-nano`](https://huggingface.co/voyageai/voyage-4-nano)**
(Apache-2.0).

> **Why this exists:** `voyage-4-nano` is a Qwen3-based model that needs
> `transformers` + `sentence-transformers` with `trust_remote_code=True` and
> query/document task-prompts — so it can't be `ollama pull`-ed. This server
> wraps that so you can run it with one command. If you just want *any* local
> model with zero fuss, use **Ollama** instead (see the repo README) — but for
> Voyage's open model, this is the turnkey path.

## Run it (one command)

From this directory:

```sh
docker compose up -d        # first start downloads the model into a persistent volume
curl localhost:8080/health  # {"status":"ok","model":"voyageai/voyage-4-nano","dims":1024}
```

Or from the **repo root**, bring it up alongside RepoSkein's other optional
services: `docker compose up -d` (see the root [`docker-compose.yml`](../docker-compose.yml)).

**Don't want to build?** Pull the prebuilt multi-arch image (amd64/arm64) — `docker run` auto-picks your architecture:

```sh
docker run -p 8080:8080 -v reposkein-hf:/root/.cache/huggingface \
  ghcr.io/reposkein/reposkein-embed
```

First boot downloads the model (a few hundred MB → the `hf-cache` volume keeps it
across restarts).

## Platforms & hardware (no NVIDIA GPU required)

The image is **CPU-only and multi-arch** — it builds and runs the same on:

| Platform | How it runs |
| --- | --- |
| **Linux x86_64 / ARM64** (incl. unified-memory ARM) | native CPU; CI builds + smoke-tests both arches |
| **macOS (Apple Silicon)** | Docker runs it CPU-only — **Docker cannot reach Metal/MPS**. To use the unified-memory GPU, run it **natively** (below) with `EMBED_DEVICE=mps`. |
| **Windows** | Docker Desktop (WSL2) — CPU |
| **NVIDIA GPU** (Linux/Windows) | `docker run --gpus all …` or uncomment the `deploy` block in compose; torch uses CUDA automatically |

CPU is perfectly usable for indexing-time embedding (it runs once per changed
node and caches). For the fastest Apple-Silicon path, use the native run below.

## Point RepoSkein at it

Set these on the RepoSkein MCP server (and restart your agent):

```sh
REPOSKEIN_EMBED_PROVIDER=http
REPOSKEIN_EMBED_URL=http://127.0.0.1:8080/v1/embeddings
REPOSKEIN_EMBED_MODEL=voyage-4-nano
REPOSKEIN_EMBED_DIMS=1024        # MUST equal EMBED_DIMS in docker-compose.yml
```

`semantic_find` now runs the hybrid lexical+embedding ranking; everything stays
local (no code egress) and falls back to pure-lexical automatically if the server
is down.

## Smoke test

```sh
curl -s localhost:8080/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"input":["parse the jwt token"],"model":"voyage-4-nano","input_type":"query"}' \
  | head -c 200
# -> {"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.01,...
```

## Configuration

| Env | Default | Notes |
| --- | --- | --- |
| `EMBED_MODEL` | `voyageai/voyage-4-nano` | any SentenceTransformer id (e.g. `BAAI/bge-m3`) |
| `EMBED_DIMS` | `1024` | voyage-4-nano Matryoshka: `2048` \| `1024` \| `512` \| `256`. The client's `REPOSKEIN_EMBED_DIMS` must match. |
| `HF_TOKEN` | — | only for gated/private models |
| `EMBED_DEVICE` | auto | `cpu` \| `mps` \| `cuda`. Auto-detects (cuda > mps > cpu). In Docker only `cpu` is reachable — even on Apple Silicon. Run natively with `mps` for Apple unified-memory GPU. |

## Run without Docker

```sh
cd embed-server
pip install -r requirements.txt
# Apple Silicon: EMBED_DEVICE=mps uses the unified-memory GPU (native only).
EMBED_MODEL=voyageai/voyage-4-nano EMBED_DIMS=1024 EMBED_DEVICE=mps \
  uvicorn app:app --host 0.0.0.0 --port 8080
```

(Native install lets torch use Apple **MPS** or an NVIDIA **CUDA** GPU directly;
omit `EMBED_DEVICE` to auto-detect, or set `cpu` to force CPU.)

Apache-2.0 (same as RepoSkein). The model's own license is on its HuggingFace card.
