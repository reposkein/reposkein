/** A throwaway Ed25519 keypair used ONLY by the supporter-entitlement tests.
 *
 *  ## This private key is committed on purpose and is worthless
 *
 *  It is not, and has never been, the key that signs real supporter tokens.
 *  It was generated for this file, it is in `SUPPORTER_PUBLIC_KEYS` only
 *  inside a `vi.mock`, and no shipped artifact trusts it — the test
 *  `supporterKeyProvenance.test.ts` asserts exactly that by feeding a token
 *  signed with this key to the UNMOCKED verifier and requiring a
 *  `bad_signature` rejection.
 *
 *  The alternative — having the real signing key available to the test suite
 *  — is how signing keys end up in CI logs, developer laptops, and forks. The
 *  production private key exists in one secret store and nowhere else (see
 *  `mcp/src/ads/supporterKey.ts` for its provenance), which necessarily means
 *  tests cannot sign with it, which necessarily means they sign with this. */

export const TEST_KID = "test-key-not-real";

export const TEST_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALE78XkITw1r0V4Qs2lZMfr/yXdDt75ibTsvQk4QsKfM=
-----END PUBLIC KEY-----
`;

export const TEST_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEILNbcEGchspSD/VgrglWlEDVQqyz9JrqT58EsgYJkx2f
-----END PRIVATE KEY-----
`;

/** The same private key as base64 PKCS#8 — the shape the Cloudflare worker
 *  takes its `SUPPORTER_SIGNING_KEY` secret in. */
export const TEST_PRIVATE_PKCS8_B64 =
  "MC4CAQAwBQYDK2VwBCIEILNbcEGchspSD/VgrglWlEDVQqyz9JrqT58EsgYJkx2f";

/** The mock body every test file that needs to MINT a token installs in place
 *  of `src/ads/supporterKey.js`. Keeps the substitution identical everywhere,
 *  so no test can accidentally end up trusting both keys at once. */
export const mockedSupporterKeyModule = {
  SUPPORTER_PUBLIC_KEYS: Object.freeze({ [TEST_KID]: TEST_PUBLIC_PEM }),
  CURRENT_SUPPORTER_KID: TEST_KID,
};

const DAY = 24 * 60 * 60;

/** Claims for a token that is valid for `days` from `now`. */
export function testClaims(now: number, days = 30, overrides: Record<string, unknown> = {}) {
  const iat = Math.floor(now / 1000);
  return {
    v: 1 as const,
    kid: TEST_KID,
    sub: "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
    tier: "skein",
    iat,
    exp: iat + days * DAY,
    ...overrides,
  };
}
