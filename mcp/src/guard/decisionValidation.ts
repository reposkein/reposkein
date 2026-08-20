/** Write-path guard for decision prose (PRD §3.6 discipline, same rules as
 *  summaries): plain text only, control chars stripped, fences/links rejected,
 *  per-field caps. Decisions are rationale, not instructions — this bounds the
 *  prompt-injection surface of a file that arrives via git pull. */

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const CODE_FENCE = /```/;
const MD_LINK = /\[[^\]]*\]\([^)]*\)/;

export const DECISION_FIELD_CAPS = {
  title: 120,
  context: 2000,
  decision: 2000,
  consequences: 2000,
  alternatives: 1000,
} as const;

export type DecisionFieldName = keyof typeof DECISION_FIELD_CAPS;

export interface DecisionProseInput {
  title: string;
  context: string;
  decision: string;
  consequences?: string;
  alternatives?: string;
}

export type SanitizeFieldsResult =
  | { ok: true; value: DecisionProseInput }
  | { ok: false; error: string };

const REQUIRED: readonly DecisionFieldName[] = ["title", "context", "decision"];

function sanitizeField(name: DecisionFieldName, input: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = input.replace(CONTROL_CHARS, "").trim();
  if (trimmed.length === 0) {
    return { ok: false, error: `${name} is empty` };
  }
  if (trimmed.length > DECISION_FIELD_CAPS[name]) {
    return { ok: false, error: `${name} exceeds ${DECISION_FIELD_CAPS[name]} characters` };
  }
  if (CODE_FENCE.test(trimmed)) {
    return { ok: false, error: `${name} must be plain text (no code fences)` };
  }
  if (MD_LINK.test(trimmed)) {
    return { ok: false, error: `${name} must be plain text (no markdown links)` };
  }
  return { ok: true, value: trimmed };
}

/** Validates + sanitizes every prose field of a decision. Optional fields are
 *  dropped when absent; required fields fail loudly. */
export function sanitizeDecisionFields(input: DecisionProseInput): SanitizeFieldsResult {
  const out: DecisionProseInput = { title: "", context: "", decision: "" };
  for (const name of REQUIRED) {
    const r = sanitizeField(name, input[name] ?? "");
    if (!r.ok) return r;
    out[name] = r.value;
  }
  for (const name of ["consequences", "alternatives"] as const) {
    const raw = input[name];
    if (raw === undefined) continue;
    const r = sanitizeField(name, raw);
    if (!r.ok) return r;
    out[name] = r.value;
  }
  return { ok: true, value: out };
}
