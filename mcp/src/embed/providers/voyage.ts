/**
 * Voyage AI EmbeddingProvider implementation.
 *
 * Endpoint: POST https://api.voyageai.com/v1/embeddings
 * Response shape: { embeddings: number[][], total_tokens: number }
 *   (NOTE: response field is "embeddings" not "data[].embedding" — confirmed from Voyage docs)
 *
 * Models:
 *   - voyage-code-3: code-specialized, 1024 dims default (Matryoshka 256/512/1024/2048),
 *     32K token context, 120K tokens/request batch limit.
 *   - voyage-4-nano: open-weight on HuggingFace (huggingface.co/voyageai/voyage-4-nano),
 *     1024 dims default, 32K context. Covered by the `http` provider when run locally
 *     via any OpenAI-compatible embedding server.
 *
 * Config env vars:
 *   REPOSKEIN_EMBED_PROVIDER=voyage
 *   REPOSKEIN_EMBED_MODEL    (default: voyage-code-3)
 *   REPOSKEIN_EMBED_DIMS     (optional; 256|512|1024|2048; default: 1024)
 *   VOYAGE_API_KEY           (required)
 */

import type { EmbeddingProvider, EmbedKind } from "../provider.js";

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const DEFAULT_MODEL = "voyage-code-3";
const DEFAULT_DIMS = 1024;
/** Max texts per request (Voyage API limit). */
const BATCH_SIZE = 1000;
/** Default embedding request timeout in ms. Override with REPOSKEIN_EMBED_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 30000;

interface VoyageResponse {
  embeddings: number[][];
  total_tokens: number;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private readonly _id = "voyage";
  private readonly _modelId: string;
  private readonly _dims: number;
  private readonly _apiKey: string;
  private readonly _timeoutMs: number;
  /** True only when the user explicitly set REPOSKEIN_EMBED_DIMS. */
  private readonly _dimsExplicit: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const apiKey = env["VOYAGE_API_KEY"];
    if (!apiKey) {
      throw new Error("VOYAGE_API_KEY is required for REPOSKEIN_EMBED_PROVIDER=voyage");
    }
    this._apiKey = apiKey;
    this._modelId = env["REPOSKEIN_EMBED_MODEL"] ?? DEFAULT_MODEL;
    const rawDims = env["REPOSKEIN_EMBED_DIMS"];
    if (rawDims !== undefined) {
      const d = Number(rawDims);
      if (!Number.isInteger(d) || d <= 0) {
        throw new Error(
          `Invalid REPOSKEIN_EMBED_DIMS="${rawDims}" — must be a positive integer (e.g. 256, 512, 1024, 2048)`
        );
      }
      this._dims = d;
      this._dimsExplicit = true;
    } else {
      this._dims = DEFAULT_DIMS;
      this._dimsExplicit = false;
    }
    const rawTimeout = env["REPOSKEIN_EMBED_TIMEOUT_MS"];
    this._timeoutMs = rawTimeout !== undefined ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
  }

  id(): string { return this._id; }
  modelId(): string { return this._modelId; }
  dims(): number { return this._dims; }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];

    // Batch up to BATCH_SIZE texts per request
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const body: Record<string, unknown> = {
        input: batch,
        model: this._modelId,
        input_type: kind,
      };
      // Only send output_dimension when the user explicitly configured it.
      // Voyage defaults to the model's native dimensionality when omitted.
      if (this._dimsExplicit) {
        body["output_dimension"] = this._dims;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeoutMs);
      let res: Response;
      try {
        res = await fetch(VOYAGE_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this._apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "(no body)");
        throw new Error(`Voyage API error ${res.status}: ${text}`);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        const text = await res.text().catch(() => "(unreadable body)");
        throw new Error(`Voyage API returned non-JSON response (${contentType}): ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as VoyageResponse;
      if (!Array.isArray(json.embeddings)) {
        throw new Error(`Voyage API response missing embeddings array: ${JSON.stringify(json)}`);
      }
      if (json.embeddings.length !== batch.length) {
        throw new Error(
          `Voyage API returned ${json.embeddings.length} embeddings for batch of ${batch.length} texts — batch count mismatch`
        );
      }
      results.push(...json.embeddings);
    }

    if (results.length !== texts.length) {
      throw new Error(
        `Voyage API returned ${results.length} total embeddings for ${texts.length} input texts — total count mismatch`
      );
    }

    return results;
  }
}
