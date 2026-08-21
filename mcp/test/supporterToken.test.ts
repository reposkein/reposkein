import { describe, it, expect, vi } from "vitest";
import { createPrivateKey, generateKeyPairSync, sign as nodeSign } from "node:crypto";

/** Every test in this file MINTS tokens, which means it needs a private key.
 *  The real one is not available here and never will be (see
 *  `supporterTestKey.ts`), so the committed key map is swapped for a
 *  throwaway one. `supporterKeyProvenance.test.ts` runs UNMOCKED and proves
 *  the substitution does not leak into anything shipped. */
vi.mock("../src/ads/supporterKey.js", async () => {
  const { TEST_KID, TEST_PUBLIC_PEM } = await import("./supporterTestKey.js");
  const { generateKeyPairSync } = await import("node:crypto");
  // A deliberately WRONG key type parked in the map, so the verifier's
  // "every trusted key must be Ed25519" guard has something to reject.
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    CURRENT_SUPPORTER_KID: TEST_KID,
    SUPPORTER_PUBLIC_KEYS: Object.freeze({
      [TEST_KID]: TEST_PUBLIC_PEM,
      "rsa-wrong-type": publicKey.export({ type: "spki", format: "pem" }).toString(),
    }),
  };
});

const {
  SUPPORTER_GRACE_MS,
  SUPPORTER_MAX_LIFETIME_MS,
  SUPPORTER_MAX_TOKEN_BYTES,
  isEntitled,
  signSupporterToken,
  verifySupporterToken,
  verifySupporterTokenClaims,
} = await import("../src/ads/supporterToken.js");
const { TEST_KID, TEST_PRIVATE_PEM, testClaims } = await import("./supporterTestKey.js");

type Claims = Parameters<typeof signSupporterToken>[0];

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function mint(overrides: Record<string, unknown> = {}, now = NOW): string {
  return signSupporterToken(testClaims(now, 30, overrides) as Claims, TEST_PRIVATE_PEM);
}

/** Replaces one character of a base64url segment with a different, still
 *  legal one — so the result is well-formed and fails ONLY on the signature. */
function flipChar(seg: string, index: number): string {
  const c = seg[index]!;
  const replacement = c === "A" ? "B" : "A";
  return seg.slice(0, index) + replacement + seg.slice(index + 1);
}

describe("supporter token — round trip", () => {
  it("signs and verifies, recovering the exact claims", () => {
    const token = mint();
    const verdict = verifySupporterToken(token, NOW);
    expect(verdict.state).toBe("valid");
    if (verdict.state !== "valid") return;
    expect(verdict.claims.tier).toBe("skein");
    expect(verdict.claims.kid).toBe(TEST_KID);
    expect(verdict.claims.v).toBe(1);
    expect(verdict.claims.exp - verdict.claims.iat).toBe(30 * 24 * 60 * 60);
    expect(isEntitled(verdict)).toBe(true);
  });

  it("produces the documented three-part `rsk1.` shape", () => {
    const parts = mint().split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("rsk1");
    for (const seg of parts.slice(1)) expect(seg).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("tolerates surrounding whitespace (tokens arrive by copy-paste)", () => {
    expect(verifySupporterToken(`\n  ${mint()}  \n`, NOW).state).toBe("valid");
  });

  it("refuses a signing key that is not Ed25519", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => signSupporterToken(testClaims(NOW) as Claims, pem)).toThrow(/ed25519/i);
  });
});

describe("supporter token — forgery and tampering", () => {
  it("rejects a payload edited after signing (the extend-my-own-expiry attack)", () => {
    const original = mint();
    const [, , sig] = original.split(".") as [string, string, string];
    const claims = verifySupporterTokenClaims(original);
    if (!claims.ok) throw new Error("fixture token failed to verify");
    // A well-formed payload granting ten more years, carrying the signature
    // from the real one. This is the attack the signature exists to stop.
    const forged = Buffer.from(
      JSON.stringify({ ...claims.claims, exp: claims.claims.exp + 3650 * 24 * 60 * 60 })
    ).toString("base64url");
    expect(verifySupporterToken(`rsk1.${forged}.${sig}`, NOW)).toEqual({
      state: "invalid",
      reason: "bad_signature",
    });
  });

  it("rejects a payload whose bytes were flipped into nonsense", () => {
    const [prefix, payload, sig] = mint().split(".") as [string, string, string];
    expect(verifySupporterToken(`${prefix}.${flipChar(payload, 10)}.${sig}`, NOW).state).toBe("invalid");
  });

  it("rejects an edited signature", () => {
    const [prefix, payload, sig] = mint().split(".") as [string, string, string];
    expect(verifySupporterToken(`${prefix}.${payload}.${flipChar(sig, 3)}`, NOW)).toEqual({
      state: "invalid",
      reason: "bad_signature",
    });
  });

  it("rejects a token signed by a key that is not the trusted one", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const foreign = signSupporterToken(
      testClaims(NOW) as Claims,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    );
    expect(verifySupporterToken(foreign, NOW)).toEqual({ state: "invalid", reason: "bad_signature" });
  });

  it("rejects a token whose payload was swapped in from another valid token", () => {
    const a = mint({ sub: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }).split(".");
    const b = mint({ sub: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }).split(".");
    const spliced = `rsk1.${a[1]}.${b[2]}`;
    expect(verifySupporterToken(spliced, NOW)).toEqual({ state: "invalid", reason: "bad_signature" });
  });

  it("rejects a token relabelled to a future format version", () => {
    // The prefix is inside the signed input precisely so this cannot work.
    const [, payload, sig] = mint().split(".") as [string, string, string];
    expect(verifySupporterToken(`rsk2.${payload}.${sig}`, NOW)).toEqual({ state: "invalid", reason: "malformed" });
  });

  it("rejects a token naming a signing key that is not in the committed map", () => {
    const token = mint({ kid: "some-other-key" });
    // The key is selected BEFORE any signature check, so this is unknown_key
    // rather than bad_signature: the token never got as far as verification.
    expect(verifySupporterToken(token, NOW)).toEqual({ state: "invalid", reason: "unknown_key" });
  });

  it("refuses to verify against a trusted key that is not Ed25519", () => {
    // Guards against a future edit putting the wrong key type in the map:
    // the algorithm must stay fixed by the code, not by what happens to be
    // in the key file.
    expect(verifySupporterToken(mint({ kid: "rsa-wrong-type" }), NOW)).toEqual({
      state: "invalid",
      reason: "unknown_key",
    });
  });

  it("cannot be granted entitlement by an unsigned payload", () => {
    const payload = Buffer.from(JSON.stringify(testClaims(NOW))).toString("base64url");
    for (const bogus of [`rsk1.${payload}.`, `rsk1.${payload}`, payload, `rsk1..${payload}`]) {
      expect(verifySupporterToken(bogus, NOW).state).toBe("invalid");
    }
  });
});

describe("supporter token — malformed input", () => {
  const cases: Array<[string, string, string]> = [
    ["empty string", "", "empty"],
    ["whitespace only", "   \n ", "empty"],
    ["no separators", "rsk1", "malformed"],
    ["two parts", "rsk1.abc", "malformed"],
    ["four parts", "rsk1.a.b.c", "malformed"],
    ["wrong prefix", "jwt.aaaa.bbbb", "malformed"],
    ["non-base64url payload", "rsk1.a+b/c=.zzzz", "malformed"],
    ["short signature", `rsk1.${Buffer.from("{}").toString("base64url")}.AAAA`, "malformed"],
  ];
  for (const [name, token, reason] of cases) {
    it(`rejects ${name} as ${reason}`, () => {
      expect(verifySupporterToken(token, NOW)).toEqual({ state: "invalid", reason });
    });
  }

  it("refuses anything over the size cap without parsing it", () => {
    const huge = `rsk1.${"A".repeat(SUPPORTER_MAX_TOKEN_BYTES)}.${"B".repeat(86)}`;
    expect(verifySupporterToken(huge, NOW)).toEqual({ state: "invalid", reason: "too_large" });
  });

  it("rejects a signature of the right encoding but the wrong length", () => {
    const [prefix, payload] = mint().split(".") as [string, string];
    const shortSig = Buffer.alloc(63).toString("base64url");
    expect(verifySupporterToken(`${prefix}.${payload}.${shortSig}`, NOW)).toEqual({
      state: "invalid",
      reason: "malformed",
    });
  });

  it("rejects a validly signed payload that is not an entitlement", () => {
    for (const bad of [{ v: 2 }, { v: 1, kid: TEST_KID }, { v: 1, kid: "BAD KID", sub: "x".repeat(16) }]) {
      const token = signSupporterToken(bad as unknown as Claims, TEST_PRIVATE_PEM);
      expect(verifySupporterToken(token, NOW)).toEqual({ state: "invalid", reason: "bad_payload" });
    }
  });

  it("rejects a subject that is not an opaque hash", () => {
    expect(verifySupporterToken(mint({ sub: "someone@example.com" }), NOW)).toEqual({
      state: "invalid",
      reason: "bad_payload",
    });
    expect(verifySupporterToken(mint({ sub: "short" }), NOW)).toEqual({ state: "invalid", reason: "bad_payload" });
  });

  it("rejects exp <= iat", () => {
    const iat = Math.floor(NOW / 1000);
    expect(verifySupporterToken(mint({ iat, exp: iat }), NOW)).toEqual({ state: "invalid", reason: "bad_payload" });
    expect(verifySupporterToken(mint({ iat, exp: iat - 1 }), NOW)).toEqual({ state: "invalid", reason: "bad_payload" });
  });

  it("rejects a tier other than skein even when perfectly signed", () => {
    expect(verifySupporterToken(mint({ tier: "gold" }), NOW)).toEqual({ state: "invalid", reason: "wrong_tier" });
    // Case matters: the comparison is exact, not normalised.
    expect(verifySupporterToken(mint({ tier: "Skein" }), NOW)).toEqual({ state: "invalid", reason: "wrong_tier" });
  });

  it("caps how long a single token may claim to live", () => {
    const iat = Math.floor(NOW / 1000);
    const overLong = mint({ iat, exp: iat + SUPPORTER_MAX_LIFETIME_MS / 1000 + 1 });
    expect(verifySupporterToken(overLong, NOW)).toEqual({ state: "invalid", reason: "implausible_lifetime" });
    const atCap = mint({ iat, exp: iat + SUPPORTER_MAX_LIFETIME_MS / 1000 });
    expect(verifySupporterToken(atCap, NOW).state).toBe("valid");
  });

  it("rejects a token issued implausibly far in the future", () => {
    const future = mint({}, NOW + 2 * DAY_MS);
    expect(verifySupporterToken(future, NOW)).toEqual({ state: "invalid", reason: "not_yet_valid" });
    // ...but tolerates a clock a few hours behind the minter's.
    expect(verifySupporterToken(mint({}, NOW + 3 * 60 * 60 * 1000), NOW).state).toBe("valid");
  });
});

describe("supporter token — non-canonical encodings", () => {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  it("rejects base64url with `=` padding", () => {
    const [, payload, sig] = mint().split(".") as [string, string, string];
    expect(verifySupporterToken(`rsk1.${payload}=.${sig}`, NOW)).toEqual({ state: "invalid", reason: "malformed" });
    expect(verifySupporterToken(`rsk1.${payload}.${sig}==`, NOW)).toEqual({ state: "invalid", reason: "malformed" });
  });

  it("rejects standard base64's `+` and `/`, which are not in the base64url alphabet", () => {
    const [, payload, sig] = mint().split(".") as [string, string, string];
    expect(verifySupporterToken(`rsk1.${payload.slice(0, -1)}+.${sig}`, NOW)).toEqual({
      state: "invalid",
      reason: "malformed",
    });
    expect(verifySupporterToken(`rsk1.${payload}.${sig.slice(0, -1)}/`, NOW)).toEqual({
      state: "invalid",
      reason: "malformed",
    });
  });

  it("rejects trailing-bit slack — a different encoding of the same bytes", () => {
    const [, payload, sig] = mint().split(".") as [string, string, string];
    // An Ed25519 signature is 64 bytes = 512 bits, encoded in 86 base64url
    // characters = 516 bits, so the final character carries 4 bits that
    // decode to nothing. Flipping the lowest of them yields a DIFFERENT
    // string that decodes to the SAME 64 bytes — the classic base64
    // malleability. Both halves are asserted: that the variant really is
    // equivalent (otherwise this test would prove nothing) and that the
    // verifier refuses it anyway.
    const last = sig[sig.length - 1]!;
    const slack = sig.slice(0, -1) + ALPHABET[ALPHABET.indexOf(last) ^ 1]!;
    expect(slack).not.toBe(sig);
    expect(Buffer.from(slack, "base64url").equals(Buffer.from(sig, "base64url"))).toBe(true);
    expect(verifySupporterToken(`rsk1.${payload}.${slack}`, NOW)).toEqual({ state: "invalid", reason: "malformed" });
  });

  it("rejects a segment padded with a leading zero group", () => {
    const [, payload, sig] = mint().split(".") as [string, string, string];
    expect(verifySupporterToken(`rsk1.AAAA${payload}.${sig}`, NOW).state).toBe("invalid");
  });

  it("rejects whitespace inside a segment (Buffer would silently skip it)", () => {
    const [, payload, sig] = mint().split(".") as [string, string, string];
    const spaced = `${payload.slice(0, 4)} ${payload.slice(4)}`;
    expect(verifySupporterToken(`rsk1.${spaced}.${sig}`, NOW)).toEqual({ state: "invalid", reason: "malformed" });
  });
});

describe("supporter token — prototype-shaped payloads", () => {
  /** Signs an arbitrary payload STRING, so a test can put keys in the JSON
   *  that no TypeScript object literal would carry through `JSON.stringify`. */
  function signRawPayload(json: string): string {
    const seg = Buffer.from(json, "utf8").toString("base64url");
    const input = `rsk1.${seg}`;
    const sig = nodeSign(null, Buffer.from(input, "ascii"), createPrivateKey(TEST_PRIVATE_PEM));
    return `${input}.${sig.toString("base64url")}`;
  }

  const claimsJson = (extra: string) =>
    `{"v":1,"kid":"${TEST_KID}","sub":"AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH","tier":"skein",` +
    `"iat":${Math.floor(NOW / 1000)},"exp":${Math.floor(NOW / 1000) + 86400}${extra}}`;

  it("rejects `__proto__` as a kid on the charset alone", () => {
    expect(verifySupporterToken(mint({ kid: "__proto__" }), NOW)).toEqual({ state: "invalid", reason: "bad_payload" });
  });

  it("rejects inherited Object properties as a kid", () => {
    // `constructor`, `toString` and friends pass the kid charset, so the key
    // lookup has to be an own-property check. A plain `KEYS[kid]` would
    // return a function here and this would not be a rejection at all.
    for (const kid of ["constructor", "tostring", "valueof", "hasownproperty"]) {
      expect(verifySupporterToken(mint({ kid }), NOW), kid).toEqual({ state: "invalid", reason: "unknown_key" });
    }
  });

  it("does not pollute Object.prototype from a payload key", () => {
    const token = signRawPayload(claimsJson(`,"__proto__":{"polluted":true}`));
    expect(verifySupporterToken(token, NOW).state).toBe("valid");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("returns only the six known claim fields, never anything extra", () => {
    const token = signRawPayload(claimsJson(`,"admin":true,"tier2":"gold"`));
    const verdict = verifySupporterToken(token, NOW);
    expect(verdict.state).toBe("valid");
    if (verdict.state !== "valid") return;
    expect(Object.keys(verdict.claims).sort()).toEqual(["exp", "iat", "kid", "sub", "tier", "v"]);
  });

  it("rejects a payload that is an array rather than an object", () => {
    expect(verifySupporterToken(signRawPayload(`[1,2,3]`), NOW)).toEqual({ state: "invalid", reason: "bad_payload" });
  });

  it("rejects a payload that is `null`", () => {
    expect(verifySupporterToken(signRawPayload(`null`), NOW)).toEqual({ state: "invalid", reason: "bad_payload" });
  });
});

describe("supporter token — expiry and the grace window", () => {
  const token = mint();
  const claims = verifySupporterTokenClaims(token);
  if (!claims.ok) throw new Error("fixture token failed to verify");
  const expMs = claims.claims.exp * 1000;

  it("is valid right up to the expiry instant", () => {
    expect(verifySupporterToken(token, expMs - 1).state).toBe("valid");
    expect(verifySupporterToken(token, expMs).state).toBe("valid");
  });

  it("enters grace one millisecond past expiry", () => {
    const verdict = verifySupporterToken(token, expMs + 1);
    expect(verdict.state).toBe("grace");
    expect(isEntitled(verdict)).toBe(true);
  });

  it("still entitles at the last instant of the grace window", () => {
    expect(verifySupporterToken(token, expMs + SUPPORTER_GRACE_MS).state).toBe("grace");
    expect(isEntitled(verifySupporterToken(token, expMs + SUPPORTER_GRACE_MS))).toBe(true);
  });

  it("stops entitling one millisecond after grace ends", () => {
    const verdict = verifySupporterToken(token, expMs + SUPPORTER_GRACE_MS + 1);
    expect(verdict.state).toBe("expired");
    expect(isEntitled(verdict)).toBe(false);
  });

  it("still reports the claims when expired, so the CLI can say when", () => {
    const verdict = verifySupporterToken(token, expMs + 400 * DAY_MS);
    expect(verdict.state).toBe("expired");
    if (verdict.state === "expired") expect(verdict.claims.exp).toBe(claims.claims.exp);
  });

  it("grace is exactly three days", () => {
    expect(SUPPORTER_GRACE_MS).toBe(3 * DAY_MS);
  });
});
