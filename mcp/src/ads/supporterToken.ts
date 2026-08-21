/** The supporter-entitlement token: format, minting, and verification.
 *
 *  ## Why not a JWT
 *
 *  A JWT's header is attacker-controlled — the `alg` field in particular has
 *  a long history of `none`/`HS256`-confusion bugs, and every JWT library
 *  carries the machinery to be configured wrong. This token has no header at
 *  all. The algorithm is Ed25519 because it is fixed in this file, the key is
 *  whichever committed public key the payload's `kid` names, and there is no
 *  wire field that can change either. That removes the entire class of
 *  algorithm-confusion attacks and removes a dependency at the same time:
 *  `node:crypto` speaks Ed25519 natively, so nothing new is installed.
 *
 *  ## Wire format
 *
 *      rsk1.<base64url(payload JSON)>.<base64url(signature)>
 *
 *  The signature covers the ASCII bytes of `rsk1.<payloadSegment>` — the
 *  ENCODED segment, not the decoded JSON. Signing the encoding sidesteps
 *  every JSON-canonicalization question (key order, whitespace, number
 *  formatting): there is exactly one byte string that was signed, and it is
 *  the one sitting in the token. The `rsk1.` prefix is inside the signed
 *  input too, so a future `rsk2` format cannot be produced by re-labelling an
 *  `rsk1` token.
 *
 *  ## Payload
 *
 *      { v: 1, kid: "skein-2026-08", sub: "<opaque>", tier: "skein",
 *        iat: <unix seconds>, exp: <unix seconds> }
 *
 *  `sub` is an opaque hash minted by the fulfilment worker (an HMAC of the
 *  supporter's Ko-fi email under a server-side salt), present only so a
 *  re-issued token can be recognised as the same subscription. It is not
 *  reversible to an email, it is never transmitted anywhere by this package,
 *  and nothing in RepoSkein reads it except `support --status`, which prints
 *  a prefix of it so a supporter can tell two tokens apart. There is no
 *  account, no device id, and no counter.
 *
 *  ## What verification deliberately does NOT do
 *
 *  No revocation list, and therefore no network call. A revocation check is a
 *  phone-home by another name, and the thing being protected is the absence
 *  of an ad — the least valuable secret in the system. A leaked token buys a
 *  stranger an ad-free experience they could equally have by setting
 *  `REPOSKEIN_ADS=off`. Expiry plus re-issue is the entire enforcement model,
 *  and that is proportionate. */

import { createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { SUPPORTER_PUBLIC_KEYS } from "./supporterKey.js";

/** Format marker and the first component of the signed input. */
export const SUPPORTER_TOKEN_PREFIX = "rsk1";

/** The only tier that entitles anyone to anything today. Compared exactly. */
export const SUPPORTER_TIER = "skein";

/** How long a token keeps working after `exp`.
 *
 *  Three days, and the reason is renewal timing, not generosity: Ko-fi bills
 *  a membership on its own schedule and the fulfilment worker mints the
 *  replacement only when that payment lands. Without a grace window a
 *  supporter whose renewal posts a few hours late would watch a paid-for
 *  feature switch itself off. Three days covers a weekend plus a payment
 *  retry; it is short enough that a cancelled membership stops mattering
 *  within the week. */
export const SUPPORTER_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Tolerance for a clock that is behind the minter's. A token whose `iat` is
 *  further in the future than this is rejected — a legitimate minter cannot
 *  produce one, so it means either a badly wrong clock or a forged payload,
 *  and both should fail loudly rather than quietly grant entitlement later. */
export const SUPPORTER_MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** Longest lifetime any single token may claim (400 days). Caps the blast
 *  radius if the signing key is ever compromised: an attacker with the key
 *  still cannot mint a token that outlives one rotation cycle. Renewal, not
 *  longevity, is the model. */
export const SUPPORTER_MAX_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;

/** Refuse to even parse anything larger. A supporter token is ~200 bytes; a
 *  megabyte of base64 in the entitlement file is not a token. */
export const SUPPORTER_MAX_TOKEN_BYTES = 4096;

export interface SupporterClaims {
  v: 1;
  kid: string;
  sub: string;
  tier: string;
  /** Issued-at, unix SECONDS (not milliseconds). */
  iat: number;
  /** Expiry, unix SECONDS. */
  exp: number;
}

/** Why a token was refused. Diagnostic only — shown by `support --status`,
 *  never transmitted. */
export type SupporterRejection =
  | "empty"
  | "too_large"
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "bad_payload"
  | "wrong_tier"
  | "implausible_lifetime"
  | "not_yet_valid";

export type SupporterVerdict =
  /** Signature good, tier right, `exp` in the future. */
  | { state: "valid"; claims: SupporterClaims }
  /** Signature good, past `exp`, still inside the grace window. */
  | { state: "grace"; claims: SupporterClaims }
  /** Signature good, past `exp` + grace. Claims are returned so the CLI can
   *  say *when* it lapsed rather than just "no". */
  | { state: "expired"; claims: SupporterClaims }
  /** Never trustworthy at any time. */
  | { state: "invalid"; reason: SupporterRejection };

/** True when the verdict entitles the holder. The one place the
 *  valid/grace distinction collapses. */
export function isEntitled(verdict: SupporterVerdict): boolean {
  return verdict.state === "valid" || verdict.state === "grace";
}

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const KID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUB_RE = /^[A-Za-z0-9_-]{8,64}$/;

function b64uEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Decodes a segment only if it is canonical base64url: the alphabet, no
 *  padding, no whitespace. `Buffer.from(..., "base64url")` is famously
 *  lenient (it will happily skip garbage), so the charset gate happens first
 *  and a token with a sloppy encoding is simply not a token. */
function b64uDecode(seg: string): Buffer | null {
  if (!SEGMENT_RE.test(seg)) return null;
  const buf = Buffer.from(seg, "base64url");
  if (buf.length === 0) return null;
  // Round-trip guard: re-encoding must reproduce the segment exactly, which
  // rules out the trailing-bit slack base64 otherwise tolerates.
  if (buf.toString("base64url") !== seg) return null;
  return buf;
}

/** Mints a token. Needs the PRIVATE key, which lives only in the fulfilment
 *  worker's secret store (see `supporterKey.ts` provenance) — nothing in the
 *  published package or the test suite uses the real one. Exported because a
 *  format is only trustworthy if the thing that writes it and the thing that
 *  reads it are specified together, and because the round-trip tests need to
 *  sign with a throwaway key. */
export function signSupporterToken(claims: SupporterClaims, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`supporter token: signing key must be ed25519, got ${key.asymmetricKeyType ?? "unknown"}`);
  }
  const payloadSeg = b64uEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  const signingInput = `${SUPPORTER_TOKEN_PREFIX}.${payloadSeg}`;
  // `null` algorithm: Ed25519 hashes internally and node:crypto requires the
  // digest argument to be null for it.
  const sig = cryptoSign(null, Buffer.from(signingInput, "ascii"), key);
  return `${signingInput}.${b64uEncode(sig)}`;
}

/** Structural + cryptographic checks, with no notion of "now". Split out so
 *  the time-dependent part is a pure function of already-verified claims —
 *  which is what lets `isSupporter()` cache the expensive half and re-decide
 *  expiry on every call for free. */
function verifyShapeAndSignature(token: string): { ok: true; claims: SupporterClaims } | { ok: false; reason: SupporterRejection } {
  const trimmed = token.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (Buffer.byteLength(trimmed, "utf8") > SUPPORTER_MAX_TOKEN_BYTES) return { ok: false, reason: "too_large" };

  const parts = trimmed.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [prefix, payloadSeg, sigSeg] = parts as [string, string, string];
  if (prefix !== SUPPORTER_TOKEN_PREFIX) return { ok: false, reason: "malformed" };

  const sigBytes = b64uDecode(sigSeg);
  // Ed25519 signatures are exactly 64 bytes; anything else is not one.
  if (!sigBytes || sigBytes.length !== 64) return { ok: false, reason: "malformed" };
  const payloadBytes = b64uDecode(payloadSeg);
  if (!payloadBytes) return { ok: false, reason: "malformed" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "bad_payload" };
  const p = parsed as Record<string, unknown>;

  if (p.v !== 1) return { ok: false, reason: "bad_payload" };
  const kid = p.kid;
  if (typeof kid !== "string" || !KID_RE.test(kid)) return { ok: false, reason: "bad_payload" };
  const sub = p.sub;
  if (typeof sub !== "string" || !SUB_RE.test(sub)) return { ok: false, reason: "bad_payload" };
  const tier = p.tier;
  if (typeof tier !== "string") return { ok: false, reason: "bad_payload" };
  const iat = p.iat;
  const exp = p.exp;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return { ok: false, reason: "bad_payload" };
  const iatN = iat as number;
  const expN = exp as number;
  if (iatN <= 0 || expN <= iatN) return { ok: false, reason: "bad_payload" };

  // Key selection happens BEFORE the signature check and is driven entirely
  // by the committed key map: an unknown `kid` can never reach verification,
  // so the token cannot nominate its own trust root.
  const pem = Object.prototype.hasOwnProperty.call(SUPPORTER_PUBLIC_KEYS, kid)
    ? SUPPORTER_PUBLIC_KEYS[kid]
    : undefined;
  if (!pem) return { ok: false, reason: "unknown_key" };

  let signatureOk = false;
  try {
    const publicKey = createPublicKey(pem);
    // Belt and braces against a future edit to the committed key map putting
    // a non-Ed25519 key in it. `crypto.verify(null, …)` would throw for most
    // other key types and be caught below, but an explicit refusal is
    // clearer than relying on which algorithms happen to reject a null
    // digest — and it is the check that keeps "the algorithm is Ed25519
    // because this file says so" literally true.
    if (publicKey.asymmetricKeyType !== "ed25519") return { ok: false, reason: "unknown_key" };
    signatureOk = cryptoVerify(
      null,
      Buffer.from(`${SUPPORTER_TOKEN_PREFIX}.${payloadSeg}`, "ascii"),
      publicKey,
      sigBytes
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return { ok: false, reason: "bad_signature" };

  // Tier and lifetime are checked only AFTER the signature: a rejection
  // before that would be a statement about an unauthenticated payload.
  if (tier !== SUPPORTER_TIER) return { ok: false, reason: "wrong_tier" };
  if ((expN - iatN) * 1000 > SUPPORTER_MAX_LIFETIME_MS) return { ok: false, reason: "implausible_lifetime" };

  return { ok: true, claims: { v: 1, kid, sub, tier, iat: iatN, exp: expN } };
}

/** Full verification: shape, signature, tier, then expiry against `now`.
 *  Pure and synchronous — no filesystem, no clock injection beyond `now`, and
 *  nothing that can touch a socket. */
export function verifySupporterToken(token: string, now: number = Date.now()): SupporterVerdict {
  const base = verifyShapeAndSignature(token);
  if (!base.ok) return { state: "invalid", reason: base.reason };
  return classifyClaims(base.claims, now);
}

/** The time-dependent half, over claims whose signature is already trusted. */
export function classifyClaims(claims: SupporterClaims, now: number = Date.now()): SupporterVerdict {
  if (claims.iat * 1000 > now + SUPPORTER_MAX_CLOCK_SKEW_MS) {
    return { state: "invalid", reason: "not_yet_valid" };
  }
  const expMs = claims.exp * 1000;
  if (now <= expMs) return { state: "valid", claims };
  if (now <= expMs + SUPPORTER_GRACE_MS) return { state: "grace", claims };
  return { state: "expired", claims };
}

/** Verifies shape + signature only, deferring every time-dependent decision
 *  to `classifyClaims`. `isSupporter()`'s cache is built on this split. */
export function verifySupporterTokenClaims(token: string): { ok: true; claims: SupporterClaims } | { ok: false; reason: SupporterRejection } {
  return verifyShapeAndSignature(token);
}
