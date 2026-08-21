import { describe, it, expect } from "vitest";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CURRENT_SUPPORTER_KID, SUPPORTER_PUBLIC_KEYS } from "../src/ads/supporterKey.js";
import { signSupporterToken, verifySupporterToken } from "../src/ads/supporterToken.js";
import { TEST_KID, TEST_PRIVATE_PEM, testClaims } from "./supporterTestKey.js";

/** Deliberately NOT mocked. Everything here is about the key that actually
 *  ships, so any `vi.mock` of `supporterKey.js` in this file would defeat the
 *  entire point of it. */

const srcPath = (rel: string) => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));

describe("the committed supporter public key", () => {
  it("is a real, parseable Ed25519 public key", () => {
    for (const [kid, pem] of Object.entries(SUPPORTER_PUBLIC_KEYS)) {
      const key = createPublicKey(pem);
      expect(key.asymmetricKeyType, `${kid} must be ed25519`).toBe("ed25519");
      expect(key.type).toBe("public");
    }
  });

  it("contains at least one key, and CURRENT_SUPPORTER_KID names one of them", () => {
    expect(Object.keys(SUPPORTER_PUBLIC_KEYS).length).toBeGreaterThan(0);
    expect(SUPPORTER_PUBLIC_KEYS[CURRENT_SUPPORTER_KID]).toBeTruthy();
  });

  it("is frozen, so nothing at runtime can add a trust root", () => {
    expect(Object.isFrozen(SUPPORTER_PUBLIC_KEYS)).toBe(true);
    expect(() => {
      (SUPPORTER_PUBLIC_KEYS as Record<string, string>).evil = "-----BEGIN PUBLIC KEY-----\n";
    }).toThrow();
    expect(SUPPORTER_PUBLIC_KEYS.evil).toBeUndefined();
  });

  it("contains no PRIVATE key material anywhere in the module", () => {
    const source = readFileSync(srcPath("ads/supporterKey.ts"), "utf8");
    expect(source).not.toMatch(/BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY/);
    expect(source).not.toMatch(/BEGIN OPENSSH PRIVATE KEY/);
  });
});

describe("no shipped code trusts a test key", () => {
  it("rejects a token signed with the committed test keypair", () => {
    // `supporterTestKey.ts` publishes a private key on purpose. If the
    // verifier ever trusted it, that file would become a universal forgery
    // kit. It does not, and this is the assertion that keeps it that way.
    const token = signSupporterToken(
      { ...testClaims(Date.now()), kid: CURRENT_SUPPORTER_KID } as never,
      TEST_PRIVATE_PEM
    );
    expect(verifySupporterToken(token, Date.now())).toEqual({ state: "invalid", reason: "bad_signature" });
  });

  it("does not know the test key's id at all", () => {
    expect(SUPPORTER_PUBLIC_KEYS[TEST_KID]).toBeUndefined();
    const token = signSupporterToken(testClaims(Date.now()) as never, TEST_PRIVATE_PEM);
    expect(verifySupporterToken(token, Date.now())).toEqual({ state: "invalid", reason: "unknown_key" });
  });

  it("rejects a token from any freshly generated key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const token = signSupporterToken(
      { ...testClaims(Date.now()), kid: CURRENT_SUPPORTER_KID } as never,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    );
    expect(verifySupporterToken(token, Date.now()).state).toBe("invalid");
  });
});
