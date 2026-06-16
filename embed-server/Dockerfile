# Ready-to-go voyage-4-nano (or any SentenceTransformer) embedding server for
# RepoSkein's `http` provider. CPU image — works anywhere; for speed mount a GPU
# (`docker run --gpus all ...`) and torch will use it automatically.
#
#   docker build -t reposkein-embed .
#   docker run -p 8080:8080 -v reposkein-hf:/root/.cache/huggingface reposkein-embed
#
# First request downloads the model into the mounted HF cache (persist it via the
# volume so restarts are instant).
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV EMBED_MODEL=voyageai/voyage-4-nano \
    EMBED_DIMS=1024 \
    HF_HOME=/root/.cache/huggingface

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
