/** The ONLY shape sponsored content is ever allowed to take inside this
 *  process (see .reposkein/decisions/2026-08-21-sponsorship-placement-*.json:
 *  "Sponsor payloads are fixed-schema and length-capped, not freeform text or
 *  markup"). Anything a network returns is projected onto this and rejected if
 *  it doesn't fit — never merged, never spread, never passed through.
 *
 *  `label` is a literal, constructed locally by `sanitizeSponsored` and never
 *  copied from the payload: the disclosure is a property of OUR envelope, not
 *  sponsor-supplied content, which is the same immutability rule the ADR fixes
 *  for the viewer chip. */
export interface SponsoredSlot {
  readonly label: typeof SPONSORED_LABEL;
  /** Headline, <= TITLE_MAX chars, plain text. */
  readonly title?: string;
  /** Body copy, <= BODY_MAX chars, plain text. */
  readonly body?: string;
  /** https, host in the ad network's click-domain allowlist. */
  readonly url: string;
}

/** Immutable. Renaming this constant renames a disclosure, which is exactly
 *  what the governing ADR forbids — `adsLabel.test.ts` asserts the literal. */
export const SPONSORED_LABEL = "sponsored";

/** Response-envelope key the slot is attached under. `_meta` (not `content`,
 *  not a new `structuredContent`) so the slot can never displace, reorder, or
 *  concatenate itself into the tool's own answer. */
export const SPONSORED_META_KEY = "reposkein/sponsored";

export const TITLE_MAX = 80;
export const BODY_MAX = 200;
export const URL_MAX = 512;
/** Anything larger than this isn't a slot payload; reject before parsing fields. */
export const PAYLOAD_MAX_BYTES = 4096;

/** Everything that leaves this machine for a slot request.
 *
 *  Deliberately not extensible: `tool` is a tool NAME from this server's own
 *  registry (a fixed, public string — `get_context_profile`), and `keywords`
 *  is coarse free text the caller opted to share. No file paths, no node ids,
 *  no code, no summaries, no repo id, no identity. See docs/SPONSORSHIP.md. */
export interface SlotContext {
  readonly tool: string;
  readonly keywords?: string;
}

/** A source of raw (untrusted) slot payloads. One implementation talks to the
 *  ad network (`luluAdsSource`); tests inject fakes. The return value is
 *  `unknown` on purpose — a source is a transport, never a validator; the
 *  ONLY validator is `sanitizeSponsored`. */
export interface SponsoredSource {
  requestSlot(ctx: SlotContext, opts: { timeoutMs: number; signal: AbortSignal }): Promise<unknown>;
}
