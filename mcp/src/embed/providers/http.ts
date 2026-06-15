/**
 * Generic HTTP/local EmbeddingProvider implementation.
 *
 * POSTs to REPOSKEIN_EMBED_URL using an OpenAI-compatible request/response shape.
 * This covers any locally-hosted embedding server, including:
 *   - voyage-4-nano (open-weight, HuggingFace: huggingface.co/voyageai/voyage-4-nano)
 *     when run via a local HTTP server (e.g. text-embeddings-inference, FastEmbed, etc.)
 *   - Any sentence-transformers / HuggingFace model via local server
 *   - Ollama embeddings endpoint
 *
 * Request body (OpenAI-compatible):
 *   { input: string[], model: string, input_type: "document"|"query" }
 * Response body (OpenAI-compatible):
 *   { data: [{ embedding: number[] }, ...] }
 *   OR Voyage-style: { embeddings: number[][] }
 * (tries .data[].embedding first, then .embeddings)
 *
 * Config env vars:
 *   REPOSKEIN_EMBED_PROVIDER=http
 *   REPOSKEIN_EMBED_URL      (required; e.g. http://127.0.0.1:8080/v1/embeddings)
 *   REPOSKEIN_EMBED_MODEL    (required; e.g. "voyage-4-nano")
 *   REPOSKEIN_EMBED_DIMS     (required; output dimension of the local model)
 */

import type { EmbeddingProvider, EmbedKind } from "../provider.js";

const DEFAULT_DIMS = 1024;

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[] }>;
}

interface VoyageEmbedResponse {
  embeddings: number[][];
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  private readonly _id = "http";
  private readonly _url: string;
  private readonly _modelId: string;
  private readonly _dims: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const url = env["REPOSKEIN_EMBED_URL"];
    if (!url) {
      throw new Error("REPOSKEIN_EMBED_URL is required for REPOSKEIN_EMBED_PROVIDER=http");
    }
    const model = env["REPOSKEIN_EMBED_MODEL"];
    if (!model) {
      throw new Error("REPOSKEIN_EMBED_MODEL is required for REPOSKEIN_EMBED_PROVIDER=http");
    }
    this._url = url;
    this._modelId = model;
    this._dims = env["REPOSKEIN_EMBED_DIMS"] ? parseInt(env["REPOSKEIN_EMBED_DIMS"], 10) : DEFAULT_DIMS;
  }

  id(): string { return this._id; }
  modelId(): string { return this._modelId; }
  dims(): number { return this._dims; }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (texts.length === 0) return [];

    const body = {
      input: texts,
      model: this._modelId,
      input_type: kind,
    };

    const res = await fetch(this._url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`HTTP embedding server error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as OpenAIEmbedResponse | VoyageEmbedResponse;

    // OpenAI-compatible shape: { data: [{ embedding: [...] }, ...] }
    if ("data" in json && Array.isArray(json.data)) {
      return (json as OpenAIEmbedResponse).data.map((d) => d.embedding);
    }

    // Voyage-style shape: { embeddings: [[...], ...] }
    if ("embeddings" in json && Array.isArray((json as VoyageEmbedResponse).embeddings)) {
      return (json as VoyageEmbedResponse).embeddings;
    }

    throw new Error(`Unrecognized embedding server response shape: ${JSON.stringify(json)}`);
  }
}
