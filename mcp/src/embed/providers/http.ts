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
/** Default embedding request timeout in ms. Override with REPOSKEIN_EMBED_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 30000;

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
  private readonly _timeoutMs: number;

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
    const rawDims = env["REPOSKEIN_EMBED_DIMS"];
    if (rawDims !== undefined) {
      const d = Number(rawDims);
      if (!Number.isInteger(d) || d <= 0) {
        throw new Error(
          `Invalid REPOSKEIN_EMBED_DIMS="${rawDims}" — must be a positive integer (e.g. 256, 512, 1024, 2048)`
        );
      }
      this._dims = d;
    } else {
      this._dims = DEFAULT_DIMS;
    }
    const rawTimeout = env["REPOSKEIN_EMBED_TIMEOUT_MS"];
    this._timeoutMs = rawTimeout !== undefined ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    let res: Response;
    try {
      res = await fetch(this._url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      throw new Error(`HTTP embedding server error ${res.status}: ${text}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = await res.text().catch(() => "(unreadable body)");
      throw new Error(`HTTP embedding server returned non-JSON response (${contentType}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as OpenAIEmbedResponse | VoyageEmbedResponse;

    // OpenAI-compatible shape: { data: [{ embedding: [...] }, ...] }
    if ("data" in json && Array.isArray(json.data)) {
      const out = (json as OpenAIEmbedResponse).data.map((d) => d.embedding);
      if (out.length !== texts.length) {
        throw new Error(
          `HTTP embedding server returned ${out.length} embeddings for ${texts.length} input texts — count mismatch`
        );
      }
      return out;
    }

    // Voyage-style shape: { embeddings: [[...], ...] }
    if ("embeddings" in json && Array.isArray((json as VoyageEmbedResponse).embeddings)) {
      const out = (json as VoyageEmbedResponse).embeddings;
      if (out.length !== texts.length) {
        throw new Error(
          `HTTP embedding server returned ${out.length} embeddings for ${texts.length} input texts — count mismatch`
        );
      }
      return out;
    }

    throw new Error(`Unrecognized embedding server response shape: ${JSON.stringify(json)}`);
  }
}
