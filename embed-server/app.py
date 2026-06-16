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
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

EMBED_MODEL = os.environ.get("EMBED_MODEL", "voyageai/voyage-4-nano")
EMBED_DIMS = int(os.environ.get("EMBED_DIMS", "1024"))

# voyage-4-nano's task prompts (from the model card) — applied automatically by
# encode_query/encode_document on recent sentence-transformers; used as a fallback
# on older versions or models without those methods.
QUERY_PROMPT = "Represent the query for retrieving supporting documents: "
DOC_PROMPT = "Represent the document for retrieval: "

app = FastAPI(title="reposkein-embed-server", version="1.0.0")
_model = None  # lazy-loaded singleton


def _load():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        # trust_remote_code is required for voyage-4-nano's custom modeling code.
        _model = SentenceTransformer(
            EMBED_MODEL,
            trust_remote_code=True,
            truncate_dim=EMBED_DIMS,
        )
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
    return {"status": "ok", "model": EMBED_MODEL, "dims": EMBED_DIMS}


@app.post("/v1/embeddings")
def embeddings(req: EmbedRequest):
    if not req.input:
        return {"object": "list", "data": [], "model": EMBED_MODEL}
    is_query = (req.input_type or "document").lower() == "query"
    vecs = _encode(req.input, is_query)
    data = [
        {"object": "embedding", "index": i, "embedding": v.tolist()}
        for i, v in enumerate(vecs)
    ]
    return {"object": "list", "data": data, "model": EMBED_MODEL}
