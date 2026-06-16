# reposkein-embed-server

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

```sh
cd embed-server
docker compose up -d        # first start downloads the model into a persistent volume
curl localhost:8080/health  # {"status":"ok","model":"voyageai/voyage-4-nano","dims":1024}
```

First boot downloads the model (a few hundred MB → the `hf-cache` volume keeps it
across restarts). CPU works out of the box; for a CUDA GPU, uncomment the `deploy`
block in `docker-compose.yml` (or `docker run --gpus all`) and it's used automatically.

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

## Run without Docker

```sh
cd embed-server
pip install -r requirements.txt
EMBED_MODEL=voyageai/voyage-4-nano EMBED_DIMS=1024 \
  uvicorn app:app --host 0.0.0.0 --port 8080
```

Apache-2.0 (same as RepoSkein). The model's own license is on its HuggingFace card.
