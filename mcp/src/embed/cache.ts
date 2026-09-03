/**
 * How a corpus node becomes a document string, and how that string is keyed.
 *
 * Storage itself lives in vectorStore.ts — fixed-stride float32 beside a JSONL
 * index — and the orchestration in corpusVectors.ts. This file is only the
 * text: what we embed, and the hash that decides when to re-embed it.
 *
 * Invalidation: `doc_hash` must match the hash of a freshly-built document
 * string, so a change to qualified_name, signature, semantic_summary or
 * file_path re-embeds the node. CorpusNode does not expose the committed
 * content_hash, so this is the sole per-row key — which is sufficient, since
 * the document is built from exactly those fields.
 */

import { createHash } from "node:crypto";
import type { CorpusNode } from "../store/GraphStore.js";

/** Build the document string for a corpus node (deterministic, same for all calls).
 *  voyage-code-3 is code-specialized, so including code-ish context plays to its strength.
 *  Document = qualified_name + optional signature + optional summary + file_path.
 */
export function buildDocString(node: CorpusNode, budget = docCharBudget()): string {
  const head: string[] = [node.qualified_name];
  if (node.signature) head.push(node.signature);
  const tail: string[] = [node.file_path];

  // Trim the SUMMARY to fit, not the tail. It is the one unbounded field —
  // agents author it — and the identifiers are what a search matches on.
  const overhead = [...head, ...tail].join("\n").length + (node.summary ? 1 : 0);
  let summary = node.summary ?? "";
  if (overhead + summary.length > budget) {
    summary = summary.slice(0, Math.max(0, budget - overhead));
  }

  const parts = [...head];
  if (summary) parts.push(summary);
  parts.push(...tail);
  // Last resort, for a node whose own name and path already exceed the budget.
  return parts.join("\n").slice(0, budget);
}

/**
 * Longest document string we will hand a provider.
 *
 * This is a correctness bound, not a preference. The bundled embedding server
 * rejects an over-long input with 413 (EMBED_MAX_INPUT_CHARS, default 8000),
 * and one rejected document fails the whole embed call — so `semantic_find`
 * would fall back to lexical, and keep falling back, because the offending
 * document is never embedded and every later attempt reissues it. Keep this at
 * or below the server's cap.
 */
export const DEFAULT_DOC_CHAR_BUDGET = 8000;

export function docCharBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["REPOSKEIN_EMBED_MAX_INPUT_CHARS"];
  if (raw === undefined) return DEFAULT_DOC_CHAR_BUDGET;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DOC_CHAR_BUDGET;
}

/** SHA-256 of a string, hex-encoded. */
export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Sanitize a model id so it is safe to use as a filename component.
 * HuggingFace-style ids ("org/model-name") contain slashes that would create
 * subdirectories; other chars like backslash or NUL could collide or confuse
 * the FS. Replace any run of unsafe characters with "_".
 */
export function sanitizeModelId(modelId: string): string {
  // Replace /, \, :, *, ?, ", <, >, |, NUL and control chars with "_"
  // Also collapse multiple consecutive underscores to avoid "___"-confusing names.
  return modelId.replace(/[/\\:*?"<>|\x00-\x1f]+/g, "_");
}
