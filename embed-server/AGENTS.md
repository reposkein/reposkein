# embed-server/

Optional FastAPI service for `semantic_find`'s hybrid embedding tier. **The only Python in the repo proper** (Track 2 bench has its own Python; this serves the runtime).

## FILES

```
app.py            # FastAPI app (:49); lazy singleton SentenceTransformer model
Dockerfile        # python:3.11-slim; runs `uvicorn app:app` on :8080 as non-root
docker-compose.yml # local single-service compose (binds 127.0.0.1:8080)
requirements.txt  # fastapi, uvicorn[standard], sentence-transformers, transformers, torch, einops
README.md         # user docs (run/platform/config)
```

**No `pyproject.toml`.** Intentional — Docker is the supported install path; `requirements.txt` is enough.

## ENDPOINTS

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ status, model, dims }` |
| POST | `/v1/embeddings` | `{ input: string[], model, input_type: "query"\|"document" }` | OpenAI-compatible `{ object: "list", data: [{ object: "embedding", index, embedding }], model }` |

## DEFAULT MODEL

`voyageai/voyage-4-nano` (Apache-2.0, Qwen3-based). Requires `trust_remote_code=True` and per-input-type prompts — **so `ollama pull` doesn't work**. That's the whole reason this service exists.

Prompts (applied via `encode_query` / `encode_document` on recent sentence-transformers; manual fallback otherwise):
- query: `"Represent the query for retrieving supporting documents: "`
- document: `"Represent the document for retrieval: "`

## CONFIG (env)

| Var | Default | Notes |
|---|---|---|
| `EMBED_MODEL` | `voyageai/voyage-4-nano` | Any SentenceTransformer id (e.g. `BAAI/bge-m3`) works. |
| `EMBED_DIMS` | `1024` | **Matryoshka truncation**: `2048`/`1024`/`512`/`256`. Client `REPOSKEIN_EMBED_DIMS` MUST match or cosine scoring is skipped. |
| `EMBED_DEVICE` | auto | `cpu`/`mps`/`cuda`. Auto-detects `cuda > mps > cpu`. |
| `HF_TOKEN` | — | Gated/private models only. |

## INVARIANTS

- **Docker can't reach Apple Metal/MPS.** For unified-memory GPU on Mac, run **natively**: `EMBED_DEVICE=mps uvicorn app:app --host 0.0.0.0 --port 8080`.
- **Binds `127.0.0.1` by default** — local helper, not LAN-exposed.
- **Multi-arch image** at `ghcr.io/reposkein/reposkein-embed:latest` (amd64 + arm64). CI smoke-tests both natively (no QEMU).
- **CPU-only by default.** GPU is the uncommented `deploy` block in compose (NVIDIA only — see anti-patterns).

## ANTI-PATTERNS

- **Adding GPU as required.** Image must work on CPU on commodity hardware (Apple Silicon, x64 Linux, Windows WSL2).
- **Changing the response shape.** RepoSkein's `http` provider expects OpenAI's `{ data: [{ embedding }] }`. Breaking this breaks every client.
- **Loading the model at import time.** Lazy singleton (`_model = None`) keeps `/health` snappy and lets Docker boot quickly.
- **`pip install -r` inside the Dockerfile without `--no-cache-dir`.** Image size matters.
- **Pinning `transformers` below 4.51.** voyage-4-nano (Qwen3) needs the recent loader.
