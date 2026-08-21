/** Token minting for the Ko-fi fulfilment worker.
 *
 *  This is the ONLY place the supporter signing key is used. It is a
 *  deliberate re-implementation of the format specified in
 *  `mcp/src/ads/supporterToken.ts` against WebCrypto instead of `node:crypto`
 *  — Workers has no `node:crypto` by default, and importing the verifier's
 *  package into an edge worker to reuse ~20 lines would be a much worse
 *  trade. The two implementations are kept honest by a test that mints here
 *  and verifies there (`mcp/test/kofiWorker.test.ts`).
 *
 *  Format (see the verifier for the full rationale):
 *
 *      rsk1.<base64url(payload JSON)>.<base64url(ed25519 signature)>
 *
 *  with the signature over the ASCII bytes of `rsk1.<payloadSegment>`.
 */

export const TOKEN_PREFIX = "rsk1";
export const TIER = "skein";

/** @param {Uint8Array|ArrayBuffer} bytes */
export function base64url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes standard base64 (NOT base64url) into bytes — the shape a PKCS#8
 *  key is pasted in.
 *  @param {string} b64 */
export function base64ToBytes(b64) {
  const binary = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Imports the base64 PKCS#8 signing key.
 *
 *  Cloudflare has supported Ed25519 under the non-standard name
 *  `NODE-ED25519` for longer than under the standard `Ed25519`, and older
 *  compatibility dates still only accept the former. Try the standard name
 *  first and fall back, so the worker runs on any compatibility date rather
 *  than failing at mint time — which is the worst possible moment, because
 *  the money has already changed hands.
 *
 *  @param {string} pkcs8Base64
 *  @returns {Promise<{key: CryptoKey, algorithm: {name: string}}>} */
export async function importSigningKey(pkcs8Base64) {
  const der = base64ToBytes(pkcs8Base64);
  const names = ["Ed25519", "NODE-ED25519"];
  let lastError;
  for (const name of names) {
    try {
      const key = await crypto.subtle.importKey("pkcs8", der, { name, namedCurve: "NODE-ED25519" }, false, ["sign"]);
      return { key, algorithm: { name } };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`SUPPORTER_SIGNING_KEY is not an importable Ed25519 PKCS#8 key: ${lastError}`);
}

/** Mints one supporter token.
 *
 *  @param {{sub: string, kid: string, iat: number, exp: number}} claims
 *  @param {string} pkcs8Base64
 *  @returns {Promise<string>} */
export async function mintSupporterToken(claims, pkcs8Base64) {
  const payload = { v: 1, kid: claims.kid, sub: claims.sub, tier: TIER, iat: claims.iat, exp: claims.exp };
  const payloadSeg = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${TOKEN_PREFIX}.${payloadSeg}`;
  const { key, algorithm } = await importSigningKey(pkcs8Base64);
  const sig = await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

/** The opaque `sub`.
 *
 *  HMAC-SHA256 of the supporter's Ko-fi identity under a server-side salt,
 *  truncated to 32 base64url characters (~192 bits — nowhere near a
 *  collision, nowhere near reversible). The salt never leaves the worker, so
 *  the token cannot be walked back to an email even by someone holding it;
 *  the hash exists only so a renewal can be recognised as the same
 *  subscription. Without the salt this would be a plain email hash, which is
 *  trivially reversible by dictionary — hence the HMAC rather than a bare
 *  digest.
 *
 *  @param {string} identity
 *  @param {string} salt */
export async function opaqueSubject(identity, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(identity.trim().toLowerCase()));
  return base64url(mac).slice(0, 32);
}

/** Constant-time string equality.
 *
 *  Both sides are hashed first, then compared byte by byte. Hashing does two
 *  things a naive `===` does not: it makes the comparison independent of
 *  input length (so the check leaks nothing about how long the real token
 *  is), and it removes any early-exit on the first differing character. The
 *  loop below has no branch on the data.
 *
 *  @param {string} a
 *  @param {string} b */
export async function constantTimeEquals(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** An unguessable one-time claim code (32 random bytes). */
export function newClaimCode() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
