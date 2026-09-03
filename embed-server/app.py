"""Ready-to-go local embedding server for RepoSkein's `http` embedding provider.

Serves an OpenAI-compatible `POST /v1/embeddings` endpoint backed by a
SentenceTransformer model. The default model is Voyage AI's open-weight
**voyage-4-nano** (Apache-2.0), which is a Qwen3-based bidirectional embedding
model requiring `trust_remote_code=True` and query/document task prompts — i.e.
exactly the kind of model you cannot just `ollama pull`. This server wraps that
complexity so RepoSkein can use it off the shelf:

    REPOSKEIN_EMBED_PROVIDER=http
    REPOSKEIN_EMBED_URL=http://127.0.0.1:8080/v1/embeddings
    REPOSKEIN_EMBED_MODEL=voyage-4-nano
    REPOSKEIN_EMBED_DIMS=1024            # MUST match EMBED_DIMS below

Request  (what RepoSkein's http provider sends):
    { "input": ["text", ...], "model": "voyage-4-nano", "input_type": "query"|"document" }
Response (OpenAI-compatible):
    { "object": "list", "data": [ { "object": "embedding", "index": 0, "embedding": [...] }, ... ], "model": "..." }

Env:
    EMBED_MODEL   HuggingFace id (default: voyageai/voyage-4-nano). Any
                  SentenceTransformer model works (e.g. BAAI/bge-m3).
    EMBED_DIMS    Matryoshka truncate dimension (voyage-4-nano: 2048|1024|512|256;
                  default 1024). The client's REPOSKEIN_EMBED_DIMS must equal this.
    HF_TOKEN      Optional HuggingFace token for gated/private models.

Backpressure env (this server refuses work it cannot afford, rather than
accepting it and taking the host down with it):
    EMBED_MAX_BATCH_ITEMS   max texts per request      (default 64)  -> 413
    EMBED_MAX_INPUT_CHARS   max characters per text    (default 8000) -> 413
    EMBED_MAX_CONCURRENCY   concurrent forward passes  (default 2)   -> 503
    EMBED_QUEUE_TIMEOUT_S   seconds to wait for a slot (default 30)
    EMBED_MAX_SEQ_LENGTH    tokens per text            (default 1024)
    EMBED_NUM_THREADS       torch intra-op threads     (default 4)
"""

from __future__ import annotations

import os
import threading
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

EMBED_MODEL = os.environ.get("EMBED_MODEL", "voyageai/voyage-4-nano")
EMBED_DIMS = int(os.environ.get("EMBED_DIMS", "1024"))
# Device: leave unset for auto-detect (cuda > mps > cpu). In Docker only `cpu`
# is available even on Apple Silicon (containers can't reach Metal/MPS). When
# running NATIVELY on a Mac, set EMBED_DEVICE=mps to use unified-memory GPU.
EMBED_DEVICE = os.environ.get("EMBED_DEVICE") or None

# ── Backpressure ────────────────────────────────────────────────────────────
# One process, one model. A request's activations are the memory that matters,
# and the endpoint is a sync `def`, so Starlette runs it in anyio's threadpool —
# 40 wide by default. Without a gate that is 40 concurrent forward passes
# against one model. Everything below exists to make the failure mode a status
# code instead of a swapping host.
EMBED_MAX_BATCH_ITEMS = int(os.environ.get("EMBED_MAX_BATCH_ITEMS", "64"))
EMBED_MAX_INPUT_CHARS = int(os.environ.get("EMBED_MAX_INPUT_CHARS", "8000"))
EMBED_MAX_CONCURRENCY = int(os.environ.get("EMBED_MAX_CONCURRENCY", "2"))
EMBED_QUEUE_TIMEOUT_S = float(os.environ.get("EMBED_QUEUE_TIMEOUT_S", "30"))
# The model card advertises 32768. Attention with an explicit bidirectional mask
# materialises a B x heads x L x L tensor, so L is quadratic in memory and a
# single pathological input is fatal. RepoSkein's doc strings are short
# (qualified name + signature + summary + path), so 1024 is generous.
EMBED_MAX_SEQ_LENGTH = int(os.environ.get("EMBED_MAX_SEQ_LENGTH", "1024"))
EMBED_NUM_THREADS = int(os.environ.get("EMBED_NUM_THREADS", "4"))

# Must be set before torch is imported to take effect on the OpenMP pools.
os.environ.setdefault("OMP_NUM_THREADS", str(EMBED_NUM_THREADS))
os.environ.setdefault("MKL_NUM_THREADS", str(EMBED_NUM_THREADS))

# voyage-4-nano's task prompts (from the model card) — applied automatically by
# encode_query/encode_document on recent sentence-transformers; used as a fallback
# on older versions or models without those methods.
QUERY_PROMPT = "Represent the query for retrieving supporting documents: "
DOC_PROMPT = "Represent the document for retrieval: "

app = FastAPI(title="reposkein-embed-server", version="1.0.0")
_model = None  # lazy-loaded singleton
# Single-flight: without it, two concurrent cold requests each construct the
# model — transiently double the weights — and that is exactly when a burst
# arrives, right after `docker compose up`.
_model_lock = threading.Lock()
_gate = threading.BoundedSemaphore(EMBED_MAX_CONCURRENCY)


def _load():
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is None:
            import torch
            from sentence_transformers import SentenceTransformer

            torch.set_num_threads(EMBED_NUM_THREADS)

            # trust_remote_code is required for voyage-4-nano's custom modeling code.
            model = SentenceTransformer(
                EMBED_MODEL,
                trust_remote_code=True,
                truncate_dim=EMBED_DIMS,
                device=EMBED_DEVICE,  # None = auto (cuda > mps > cpu)
            )
            model.max_seq_length = min(model.max_seq_length, EMBED_MAX_SEQ_LENGTH)
            _model = model
    return _model


def _encode(texts: list[str], is_query: bool):
    model = _load()
    # Prefer the model's task-specific helpers (apply the right prompts + L2-norm).
    if is_query and hasattr(model, "encode_query"):
        return model.encode_query(texts)
    if not is_query and hasattr(model, "encode_document"):
        return model.encode_document(texts)
    # Fallback for models/versions without encode_query/encode_document.
    prompt = QUERY_PROMPT if is_query else DOC_PROMPT
    return model.encode(texts, prompt=prompt, normalize_embeddings=True)


class EmbedRequest(BaseModel):
    input: list[str]
    model: Optional[str] = None
    input_type: Optional[str] = None  # "query" | "document"


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": EMBED_MODEL,
        "dims": EMBED_DIMS,
        "limits": {
            "max_batch_items": EMBED_MAX_BATCH_ITEMS,
            "max_input_chars": EMBED_MAX_INPUT_CHARS,
            "max_concurrency": EMBED_MAX_CONCURRENCY,
            "max_seq_length": EMBED_MAX_SEQ_LENGTH,
        },
    }


@app.post("/v1/embeddings")
def embeddings(req: EmbedRequest):
    if not req.input:
        return {"object": "list", "data": [], "model": EMBED_MODEL}

    # Reject oversize work before allocating anything for it. RepoSkein's client
    # batches to these limits already; anything larger is a misconfigured caller.
    if len(req.input) > EMBED_MAX_BATCH_ITEMS:
        raise HTTPException(
            status_code=413,
            detail=(
                f"{len(req.input)} inputs exceeds EMBED_MAX_BATCH_ITEMS={EMBED_MAX_BATCH_ITEMS}. "
                "Lower REPOSKEIN_EMBED_MAX_BATCH_ITEMS on the client, or raise the server limit."
            ),
        )
    for i, text in enumerate(req.input):
        if len(text) > EMBED_MAX_INPUT_CHARS:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"input[{i}] is {len(text)} characters, over EMBED_MAX_INPUT_CHARS="
                    f"{EMBED_MAX_INPUT_CHARS}."
                ),
            )

    # Wait briefly for a slot, then refuse. Queueing without a bound is how a
    # burst turns into 40 simultaneous forward passes.
    if not _gate.acquire(timeout=EMBED_QUEUE_TIMEOUT_S):
        return JSONResponse(
            status_code=503,
            headers={"Retry-After": "5"},
            content={
                "error": {
                    "message": (
                        f"server busy: {EMBED_MAX_CONCURRENCY} concurrent requests already in "
                        "flight. Retry shortly."
                    ),
                    "type": "over_capacity",
                }
            },
        )
    try:
        is_query = (req.input_type or "document").lower() == "query"
        vecs = _encode(req.input, is_query)
        data = [
            {"object": "embedding", "index": i, "embedding": v.tolist()}
            for i, v in enumerate(vecs)
        ]
    finally:
        _gate.release()

    # Return the response object directly: FastAPI then skips jsonable_encoder,
    # which would otherwise walk and copy every float a second time.
    return JSONResponse(content={"object": "list", "data": data, "model": EMBED_MODEL})
