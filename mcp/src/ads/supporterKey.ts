/** The public half of the supporter-entitlement signing key (REP-29).
 *
 *  Baked into the published package on purpose. Verification of a supporter
 *  token is a purely local operation — signature, tier, expiry — and this
 *  constant is the whole trust root for it. Nothing about entitlement needs a
 *  server, so nothing about entitlement contacts one: no licence check, no
 *  activation call, no heartbeat, no way for us to learn that you ran the
 *  tool. That property is only achievable if the verifier ships with the key.
 *
 *  ## Provenance
 *
 *  - Algorithm: Ed25519 (RFC 8032), SPKI/PEM encoding.
 *  - Generated 2026-08-21 with `node:crypto` `generateKeyPairSync("ed25519")`
 *    on the maintainer's machine, during the REP-29 implementation.
 *  - The PRIVATE half was never committed and never left that machine except
 *    into a secret store. Its only consumer is the Ko-fi fulfilment worker
 *    (`workers/kofi-fulfillment/`), which holds it as the Cloudflare secret
 *    `SUPPORTER_SIGNING_KEY`. No developer workflow, no test, and no part of
 *    the published package needs it: tests that must sign generate their own
 *    throwaway keypair.
 *
 *  ## What this key can and cannot do for us
 *
 *  Publishing the public half means anyone can *verify* a token; only the
 *  holder of the private half can *mint* one. It also means a supporter can
 *  read their own token's payload — which is deliberate, and why the payload
 *  contains nothing but an opaque subject hash, a tier name, and two
 *  timestamps (see `supporterToken.ts`). There is nothing in it to hide,
 *  because there is nothing in it about you.
 *
 *  ## Rotation
 *
 *  Tokens carry a `kid`. To rotate: add the new public key here alongside the
 *  old one, keep verifying both until every issued token has expired, then
 *  drop the old entry. Removing a key invalidates every token signed with it,
 *  so a rotation that is not additive-then-subtractive will strand paying
 *  supporters. The verifier already selects by `kid`, so the only change a
 *  rotation needs is to this map. */

/** Key id → SPKI PEM. Every entry is a key tokens may legitimately be signed
 *  with; a token naming a `kid` absent from this map is rejected before any
 *  signature check happens. */
export const SUPPORTER_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "skein-2026-08": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAV7vHvsTIlioxm9pWOJ83/sEZW/ps8ymd2I+LZeucnOk=
-----END PUBLIC KEY-----
`,
});

/** The key the minter should be signing with today. Only the fulfilment
 *  worker cares; the verifier accepts anything in `SUPPORTER_PUBLIC_KEYS`. */
export const CURRENT_SUPPORTER_KID = "skein-2026-08";
