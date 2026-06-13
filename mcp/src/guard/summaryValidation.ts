export type SanitizeResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

const MAX_LEN = 1000;
// Control chars except tab (\t, 0x09), newline (\n, 0x0A), carriage return (\r, 0x0D).
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const CODE_FENCE = /```/;
const MD_LINK = /\[[^\]]*\]\([^)]*\)/;
const CODE_FENCE_G = /```/g;
const MD_LINK_G = /\[([^\]]*)\]\([^)]*\)/g;

/** Validates + sanitizes an agent summary (PRD §3.6): strips control chars,
 *  rejects oversized / non-plain-text input. Summaries are descriptions, not
 *  instructions — this bounds the prompt-injection surface. */
export function sanitizeSummary(input: string): SanitizeResult {
  const stripped = input.replace(CONTROL_CHARS, "");
  const trimmed = stripped.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "summary is empty" };
  }
  if (trimmed.length > MAX_LEN) {
    return { ok: false, error: `summary exceeds ${MAX_LEN} characters` };
  }
  if (CODE_FENCE.test(trimmed)) {
    return { ok: false, error: "summary must be plain text (no code fences)" };
  }
  if (MD_LINK.test(trimmed)) {
    return { ok: false, error: "summary must be plain text (no markdown links)" };
  }
  return { ok: true, value: trimmed };
}

/** Neutralizes a summary for display on the READ path (PRD §3.6). Unlike
 *  sanitizeSummary (write path, which REJECTS), this never fails — it strips
 *  control chars + code fences and unwraps markdown links to their text, for
 *  summaries that arrived via git pull, a hand-edited nodes.jsonl, or a
 *  DB/sidecar overlay and so never passed the write guard. Bounds the
 *  prompt-injection surface that the agent pastes into its reasoning. */
export function neutralizeSummary(input: string | null): string | null {
  if (input == null) return null;
  const out = input
    .replace(CONTROL_CHARS, "")
    .replace(CODE_FENCE_G, "")
    .replace(MD_LINK_G, "$1")
    .trim();
  return out.length > 0 ? out : null;
}
