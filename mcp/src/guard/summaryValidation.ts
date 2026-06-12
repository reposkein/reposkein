export type SanitizeResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

const MAX_LEN = 1000;
// Control chars except tab (\t, 0x09), newline (\n, 0x0A), carriage return (\r, 0x0D).
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const CODE_FENCE = /```/;
const MD_LINK = /\[[^\]]*\]\([^)]*\)/;

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
