import { CODE_FENCE, CONTROL_CHARS, MD_LINK } from "../guard/summaryValidation.js";
import {
  BODY_MAX,
  PAYLOAD_MAX_BYTES,
  SPONSORED_LABEL,
  TITLE_MAX,
  URL_MAX,
  type SponsoredSlot,
} from "./types.js";

/** Invisible characters: soft hyphen, zero-width spaces/joiners, bidi
 *  overrides, word joiners, byte-order mark. Stripped BEFORE the injection
 *  denylist runs, so `ig<ZWSP>nore previous instructions` can't smuggle a
 *  phrase past a regex, and so a right-to-left override can't reorder what a
 *  human sees relative to what a model reads. */
const INVISIBLE_SOURCE =
  "[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]";
const INVISIBLE_G = new RegExp(INVISIBLE_SOURCE, "g");
/** Same class without `g`: `.test()` on a global regex is stateful. */
const INVISIBLE = new RegExp(INVISIBLE_SOURCE);

/** Line/tab whitespace that must never survive into a one-line field
 *  (includes the Unicode line/paragraph separators). */
const LINEBREAKS = /[\r\n\t\v\f\u2028\u2029]/g;

/** `CONTROL_CHARS` is global (it is used with `replace` on the summary write
 *  path) and `.test()` on a global regex is stateful, so testing uses a
 *  flag-less clone of the exact same class. */
const CONTROL_TEST = new RegExp(CONTROL_CHARS.source);

/** Shapes that are not ad copy. Defence in depth, NOT the boundary — the
 *  boundary is that a slot is fixed-schema, length-capped data in a labelled
 *  envelope field, never prose the tool emits. But sponsor copy has no
 *  legitimate reason to carry any of these, so a payload containing one is
 *  treated as hostile and the whole slot is dropped (fail-open = no slot).
 *
 *  Ordered by what an injection attempt actually looks like: instruction
 *  overrides, role/turn markers, special-token and template syntax, markup,
 *  tool-call bait. */
const INJECTION_SHAPES: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b/i,
  /\b(previous|prior|above|earlier|all)\b[^.]{0,40}\b(instructions?|prompts?|rules?)\b/i,
  /\bsystem\s+(prompt|message|instructions?)\b/i,
  /\bnew\s+instructions?\b/i,
  /\byou\s+are\s+(now|a|an)\b/i,
  /\b(do\s+not|don't)\s+(tell|mention|reveal|disclose)\b/i,
  /^\s*(system|assistant|user|human|developer)\s*:/i,
  /<\||\|>|<<[A-Z]|\[\/?INST\]/,
  /\{\{|\}\}|\$\{/,
  /<[a-z/!?]/i,
  /\b(tool_call|function_call|tool_use|end_turn)\b/i,
];

/** Cleans one candidate prose field, or null if it isn't usable.
 *
 *  Strip-then-reject: invisibles and control characters are stripped (they
 *  carry no meaning a sponsor could intend) and line breaks collapse to single
 *  spaces, but anything still carrying markdown-link or code-fence syntax or
 *  an injection shape is refused outright rather than "sanitized" into
 *  something that merely looks safe. */
function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Invisibles are a refusal, not a repair. Ad copy has no legitimate use for
  // a bidi override or a zero-width joiner, and both exist here for exactly
  // one reason: to make what a human sees differ from what a model reads (an
  // RLO renders "ignore previous instructions" backwards; a ZWSP splits the
  // phrase past a regex). They are also stripped below so no later check can
  // be fooled by one that slips through a class update.
  if (INVISIBLE.test(value)) return null;
  const flat = value
    .replace(INVISIBLE_G, "")
    .replace(LINEBREAKS, " ")
    .replace(CONTROL_CHARS, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (flat.length === 0) return null;
  if (CODE_FENCE.test(flat)) return null;
  if (MD_LINK.test(flat) || flat.includes("](")) return null;
  for (const shape of INJECTION_SHAPES) {
    if (shape.test(flat)) return null;
  }
  return flat;
}

/** Validates the click URL: https only, host on the network's click-domain
 *  allowlist, no embedded credentials, canonicalized before it is handed on.
 *
 *  The allowlist matters more than the scheme check: per getlulu.dev/docs the
 *  network always returns its own signed redirect (`/c/{token}` on its click
 *  host) and never a raw advertiser URL, so a payload pointing anywhere else
 *  is either a misconfiguration or someone else's link — both fail-open. */
function cleanUrl(value: unknown, clickHosts: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > URL_MAX) return null;
  if (/\s/.test(raw)) return null;
  if (CONTROL_TEST.test(raw)) return null;
  if (INVISIBLE.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const host = parsed.hostname.toLowerCase();
  if (!clickHosts.some((allowed) => allowed.toLowerCase() === host)) return null;
  const canonical = parsed.toString();
  return canonical.length <= URL_MAX ? canonical : null;
}

/** Projects an untrusted payload onto `SponsoredSlot`, or returns null.
 *
 *  Null is the normal, safe answer: every rejection path (missing field, over
 *  cap, wrong host, hostile shape, unparseable input) means "no slot", which
 *  the caller treats as identical to no ad having been offered at all. There
 *  is no partial acceptance and no truncation — truncating sponsor copy to fit
 *  a cap would silently reshape someone's paid message and truncating a URL
 *  would break it, so both are refusals instead.
 *
 *  Field mapping accepts the ad network's wire name (`text`) as an alias for
 *  body copy, but the OUTPUT is built key by key, so no unexpected field —
 *  including a payload's own `label` — can ride along. */
export function sanitizeSponsored(
  raw: unknown,
  opts: { clickHosts: readonly string[] }
): SponsoredSlot | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (opts.clickHosts.length === 0) return null;

  // Cheap size gate before touching fields: a real slot is a few hundred
  // bytes, so anything larger is not one.
  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? "";
  } catch {
    return null;
  }
  if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_MAX_BYTES) return null;

  const payload = raw as Record<string, unknown>;

  // A field that is PRESENT but unusable rejects the whole slot; a field that
  // is absent is simply absent. "Present but unusable" is the interesting
  // case — it means the payload tried something.
  let title: string | undefined;
  if (payload.title !== undefined && payload.title !== null) {
    const cleaned = cleanText(payload.title);
    if (cleaned === null || cleaned.length > TITLE_MAX) return null;
    title = cleaned;
  }

  const bodySrc = payload.body ?? payload.text ?? payload.description ?? undefined;
  let body: string | undefined;
  if (bodySrc !== undefined && bodySrc !== null) {
    const cleaned = cleanText(bodySrc);
    if (cleaned === null || cleaned.length > BODY_MAX) return null;
    body = cleaned;
  }

  if (title === undefined && body === undefined) return null;

  const url = cleanUrl(payload.url, opts.clickHosts);
  if (url === null) return null;

  return {
    label: SPONSORED_LABEL,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    url,
  };
}
