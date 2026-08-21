import { describe, it, expect } from "vitest";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CURRENT_SUPPORTER_KID, SUPPORTER_PUBLIC_KEYS } from "../src/ads/supporterKey.js";
import { SUPPORTER_MAX_LIFETIME_MS, signSupporterToken, verifySupporterToken } from "../src/ads/supporterToken.js";
import { DEFAULTS as WORKER_DEFAULTS } from "../../workers/kofi-fulfillment/src/handler.js";
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

/** The worst bug this system can have is not a forged token — it is a
 *  correctly minted one that no client accepts, because the worker signs with
 *  a `kid` the package does not ship or asks for a lifetime the verifier caps.
 *  That failure takes somebody's money and gives them nothing, and it would
 *  surface only as a support message weeks later. So the minter's
 *  configuration is asserted against the verifier's rules here, and a skew is
 *  a failing test rather than a discovery. */
describe("minter and verifier configuration cannot drift apart", () => {
  const wranglerPath = fileURLToPath(new URL("../../workers/kofi-fulfillment/wrangler.toml", import.meta.url));
  const wrangler = readFileSync(wranglerPath, "utf8");

  /** Reads a `NAME = "value"` line from wrangler.toml, ignoring comments. */
  function wranglerVar(name: string): string {
    const match = wrangler.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"));
    if (!match) throw new Error(`${name} not found in wrangler.toml`);
    return match[1]!;
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  it("the worker's default SUPPORTER_KID is a key this package trusts", () => {
    expect(Object.keys(SUPPORTER_PUBLIC_KEYS)).toContain(WORKER_DEFAULTS.SUPPORTER_KID);
  });

  it("wrangler.toml's SUPPORTER_KID is a key this package trusts", () => {
    expect(Object.keys(SUPPORTER_PUBLIC_KEYS)).toContain(wranglerVar("SUPPORTER_KID"));
  });

  it("the worker default, wrangler.toml and CURRENT_SUPPORTER_KID all name the same key", () => {
    expect(wranglerVar("SUPPORTER_KID")).toBe(WORKER_DEFAULTS.SUPPORTER_KID);
    expect(WORKER_DEFAULTS.SUPPORTER_KID).toBe(CURRENT_SUPPORTER_KID);
  });

  it("the minted lifetime fits inside the verifier's cap", () => {
    for (const [source, days] of [
      ["worker DEFAULTS", Number(WORKER_DEFAULTS.TOKEN_TTL_DAYS)],
      ["wrangler.toml", Number(wranglerVar("TOKEN_TTL_DAYS"))],
    ] as const) {
      expect(Number.isFinite(days), `${source} TOKEN_TTL_DAYS must be a number`).toBe(true);
      expect(days, `${source} TOKEN_TTL_DAYS must be positive`).toBeGreaterThan(0);
      expect(days * DAY_MS, `${source} TOKEN_TTL_DAYS exceeds the verifier's lifetime cap`).toBeLessThanOrEqual(
        SUPPORTER_MAX_LIFETIME_MS
      );
    }
  });

  it("the worker default and wrangler.toml agree on every shared setting", () => {
    for (const name of ["KOFI_TIER_NAME", "TOKEN_TTL_DAYS", "CLAIM_TTL_DAYS", "CLAIM_MAX_READS"] as const) {
      expect(wranglerVar(name), name).toBe(WORKER_DEFAULTS[name]);
    }
  });
});
