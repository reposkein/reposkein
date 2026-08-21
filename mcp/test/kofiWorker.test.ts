import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../src/ads/supporterKey.js", async () => {
  const { mockedSupporterKeyModule } = await import("./supporterTestKey.js");
  return mockedSupporterKeyModule;
});

const { verifySupporterToken, verifySupporterTokenClaims } = await import("../src/ads/supporterToken.js");
const { TEST_KID, TEST_PRIVATE_PKCS8_B64 } = await import("./supporterTestKey.js");

/** The worker is plain ESM with no build step, so it is imported straight
 *  from `workers/` and exercised as a function. Minting happens there with
 *  WebCrypto and verification happens here with `node:crypto`; if the two
 *  implementations of the token format ever drift, this file stops passing. */
const { handleRequest, handleKofiWebhook } = await import("../../workers/kofi-fulfillment/src/handler.js");

/** Minimal in-memory stand-in for a Workers KV namespace. TTLs are recorded
 *  but not enforced — expiry is Cloudflare's job, and asserting on the value
 *  we passed is what actually catches a mistake here. */
class FakeKV {
  store = new Map<string, string>();
  ttls = new Map<string, number | undefined>();
  async get(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }) {
    this.store.set(key, value);
    this.ttls.set(key, opts?.expirationTtl);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

const WEBHOOK_TOKEN = "kofi-verification-token-abc123";
let kv: FakeKV;
let env: Record<string, unknown>;

beforeEach(() => {
  kv = new FakeKV();
  env = {
    KOFI_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    SUPPORTER_SIGNING_KEY: TEST_PRIVATE_PKCS8_B64,
    SUBJECT_SALT: "a-random-salt-for-tests-only",
    SUPPORTER_CLAIMS: kv,
    SUPPORTER_KID: TEST_KID,
    KOFI_TIER_NAME: "Skein",
    PUBLIC_BASE_URL: "https://kofi.example.test",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ko-fi posts `application/x-www-form-urlencoded` with the whole event as a
 *  JSON string in a single `data` field. */
function kofiRequest(payload: Record<string, unknown>, url = "https://kofi.example.test/kofi"): Request {
  const body = new URLSearchParams({ data: JSON.stringify(payload) });
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function membershipPayload(overrides: Record<string, unknown> = {}) {
  return {
    verification_token: WEBHOOK_TOKEN,
    message_id: "3a1fac0c-f960-4506-a60e-824979a74e74",
    timestamp: "2026-08-21T12:00:00Z",
    type: "Subscription",
    is_public: true,
    from_name: "Jo Supporter",
    message: "keep it up",
    amount: "5.00",
    url: "https://ko-fi.com/Home/CoffeeShop?txid=x",
    email: "Jo.Supporter@example.com",
    currency: "USD",
    is_subscription_payment: true,
    is_first_subscription_payment: true,
    kofi_transaction_id: "00000000-1111-2222-3333-444444444444",
    tier_name: "Skein",
    shop_items: null,
    shipping: null,
    ...overrides,
  };
}

async function tokenFromClaimUrl(claimUrl: string): Promise<string> {
  const res = await handleRequest(new Request(claimUrl), env, undefined);
  expect(res.status).toBe(200);
  const body = await res.text();
  const match = body.match(/reposkein-mcp support (\S+)/);
  if (!match) throw new Error(`no token in claim page:\n${body}`);
  return match[1]!;
}

describe("Ko-fi webhook — authentication", () => {
  it("rejects a wrong verification token with 401 and mints nothing", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload({ verification_token: "wrong" })), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(kv.store.size).toBe(0);
  });

  it("rejects a missing verification token", async () => {
    const payload = membershipPayload();
    delete (payload as Record<string, unknown>).verification_token;
    expect((await handleKofiWebhook(kofiRequest(payload), env)).status).toBe(401);
    expect(kv.store.size).toBe(0);
  });

  it("rejects a token that is a prefix of the real one", async () => {
    const res = await handleKofiWebhook(
      kofiRequest(membershipPayload({ verification_token: WEBHOOK_TOKEN.slice(0, -1) })),
      env
    );
    expect(res.status).toBe(401);
  });

  it("fails closed (500) when the server has no webhook token configured", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload()), { ...env, KOFI_WEBHOOK_TOKEN: "" });
    expect(res.status).toBe(500);
    expect(kv.store.size).toBe(0);
  });

  it("rejects a body that is not a Ko-fi event", async () => {
    const bad = new Request("https://kofi.example.test/kofi", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: "not json" }),
    });
    expect((await handleKofiWebhook(bad, env)).status).toBe(400);
  });

  it("rejects a POST with no `data` field", async () => {
    const bad = new Request("https://kofi.example.test/kofi", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ other: "x" }),
    });
    const res = await handleKofiWebhook(bad, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_data_field" });
  });
});

describe("Ko-fi webhook — event selection", () => {
  it("ignores a one-off donation", async () => {
    const res = await handleKofiWebhook(
      kofiRequest(membershipPayload({ type: "Donation", is_subscription_payment: false, tier_name: null })),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "not_a_subscription_payment" });
    expect(kv.store.size).toBe(0);
  });

  it("ignores a subscription to a different tier", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload({ tier_name: "Coffee" })), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true, reason: "other_tier" });
    expect(kv.store.size).toBe(0);
  });

  it("ignores a shop order", async () => {
    const res = await handleKofiWebhook(
      kofiRequest(membershipPayload({ type: "Shop Order", is_subscription_payment: false, tier_name: null })),
      env
    );
    expect((await res.json()).ignored).toBe(true);
  });

  it("matches the tier name case-insensitively", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload({ tier_name: "  skein " })), env);
    expect((await res.json()).ok).toBe(true);
    expect((await handleKofiWebhook(kofiRequest(membershipPayload()), env)).status).toBe(200);
  });

  it("answers ignored events with 200 so Ko-fi does not retry them forever", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload({ is_subscription_payment: false })), env);
    expect(res.status).toBe(200);
  });
});

describe("Ko-fi webhook — minting", () => {
  it("mints a token the shipped verifier accepts", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload()), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.claim_url).toMatch(/^https:\/\/kofi\.example\.test\/claim\/[A-Za-z0-9_-]{43}$/);

    const token = await tokenFromClaimUrl(body.claim_url);
    const verdict = verifySupporterToken(token);
    expect(verdict.state).toBe("valid");
    if (verdict.state !== "valid") return;
    expect(verdict.claims.tier).toBe("skein");
    expect(verdict.claims.kid).toBe(TEST_KID);
    // Default TOKEN_TTL_DAYS is 35.
    expect(verdict.claims.exp - verdict.claims.iat).toBe(35 * 24 * 60 * 60);
  });

  it("honours TOKEN_TTL_DAYS", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload()), { ...env, TOKEN_TTL_DAYS: "7" });
    const token = await tokenFromClaimUrl((await res.json()).claim_url);
    const parsed = verifySupporterTokenClaims(token);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.claims.exp - parsed.claims.iat).toBe(7 * 24 * 60 * 60);
  });

  it("puts an opaque subject in the token — never the email", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload()), env);
    const token = await tokenFromClaimUrl((await res.json()).claim_url);
    const parsed = verifySupporterTokenClaims(token);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.claims.sub).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(token).not.toMatch(/example\.com/i);
    expect(Buffer.from(token.split(".")[1]!, "base64url").toString()).not.toMatch(/supporter/i);
  });

  it("derives the same subject for the same email regardless of case", async () => {
    const a = await handleKofiWebhook(kofiRequest(membershipPayload({ message_id: "m1" })), env);
    const b = await handleKofiWebhook(
      kofiRequest(membershipPayload({ message_id: "m2", email: "JO.SUPPORTER@EXAMPLE.COM" })),
      env
    );
    const subOf = async (r: Response) => {
      const token = await tokenFromClaimUrl((await r.json()).claim_url);
      const parsed = verifySupporterTokenClaims(token);
      if (!parsed.ok) throw new Error("token did not verify");
      return parsed.claims.sub;
    };
    expect(await subOf(a)).toBe(await subOf(b));
  });

  it("derives a different subject under a different salt", async () => {
    const a = await handleKofiWebhook(kofiRequest(membershipPayload({ message_id: "m1" })), env);
    const b = await handleKofiWebhook(kofiRequest(membershipPayload({ message_id: "m2" })), {
      ...env,
      SUBJECT_SALT: "a-completely-different-salt",
    });
    const subOf = async (r: Response) => {
      const token = await tokenFromClaimUrl((await r.json()).claim_url);
      const parsed = verifySupporterTokenClaims(token);
      if (!parsed.ok) throw new Error("token did not verify");
      return parsed.claims.sub;
    };
    expect(await subOf(a)).not.toBe(await subOf(b));
  });

  it("is idempotent across Ko-fi's webhook retries", async () => {
    const first = await (await handleKofiWebhook(kofiRequest(membershipPayload()), env)).json();
    const second = await (await handleKofiWebhook(kofiRequest(membershipPayload()), env)).json();
    expect(second.duplicate).toBe(true);
    expect(second.claim_url).toBe(first.claim_url);
    expect([...kv.store.keys()].filter((k) => k.startsWith("claim:"))).toHaveLength(1);
  });

  it("fails closed when the signing key or salt is missing", async () => {
    for (const missing of ["SUPPORTER_SIGNING_KEY", "SUBJECT_SALT"]) {
      const res = await handleKofiWebhook(kofiRequest(membershipPayload()), { ...env, [missing]: "" });
      expect(res.status, missing).toBe(500);
    }
    const noKv = await handleKofiWebhook(kofiRequest(membershipPayload()), { ...env, SUPPORTER_CLAIMS: undefined });
    expect(noKv.status).toBe(500);
  });

  it("falls back to the transaction id when Ko-fi supplies no email", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload({ email: "" })), env);
    expect(res.status).toBe(200);
    const token = await tokenFromClaimUrl((await res.json()).claim_url);
    expect(verifySupporterToken(token).state).toBe("valid");
  });

  it("stores the claim with the configured TTL", async () => {
    await handleKofiWebhook(kofiRequest(membershipPayload()), { ...env, CLAIM_TTL_DAYS: "10" });
    const key = [...kv.ttls.keys()].find((k) => k.startsWith("claim:"))!;
    expect(kv.ttls.get(key)).toBe(10 * 24 * 60 * 60);
  });

  it("falls back to the default TTL when the setting is not a number", async () => {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload()), {
      ...env,
      TOKEN_TTL_DAYS: "thirty-five",
      CLAIM_TTL_DAYS: "-1",
    });
    expect(res.status).toBe(200);
    const token = await tokenFromClaimUrl((await res.json()).claim_url);
    const parsed = verifySupporterTokenClaims(token);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.claims.exp - parsed.claims.iat).toBe(35 * 24 * 60 * 60);
    const key = [...kv.ttls.keys()].find((k) => k.startsWith("claim:"))!;
    expect(kv.ttls.get(key)).toBe(30 * 24 * 60 * 60);
  });

  it("notifies the maintainer with the claim CODE and never a fetchable link", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await handleKofiWebhook(kofiRequest(membershipPayload()), {
      ...env,
      NOTIFY_WEBHOOK_URL: "https://discord.example.test/hook",
    });
    const { claim_url } = await res.json();
    const code = claim_url.split("/claim/")[1];
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.example.test/hook");
    const sent = JSON.parse(String(init.body));

    // The code is there so the maintainer can build the link...
    expect(sent.content).toContain(code);
    expect(sent.content).toContain("Jo Supporter");
    // ...but there is NO URL in the message. Discord and Slack GET every link
    // posted to them to build a preview, which would spend one of the
    // supporter's reads and hand the token to the platform's crawler before
    // the supporter has seen it.
    expect(sent.content).not.toContain(claim_url);
    expect(sent.content).not.toMatch(/https?:\/\//);
    // And still no email address.
    expect(sent.content).not.toContain("example.com");
  });

  it("sends both `content` and `text` so one webhook URL works for Discord or Slack", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    await handleKofiWebhook(kofiRequest(membershipPayload()), {
      ...env,
      NOTIFY_WEBHOOK_URL: "https://hooks.example.test/hook",
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    // Slack requires `text` and rejects a body without it; Discord requires
    // `content`. Sending both means neither has to be configured for.
    expect(typeof sent.content).toBe("string");
    expect(sent.text).toBe(sent.content);
  });

  it("still succeeds when the notification webhook fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("discord is down");
    }));
    const res = await handleKofiWebhook(kofiRequest(membershipPayload()), {
      ...env,
      NOTIFY_WEBHOOK_URL: "https://discord.example.test/hook",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("the claim endpoint", () => {
  async function mintClaimUrl(): Promise<string> {
    const res = await handleKofiWebhook(kofiRequest(membershipPayload()), env);
    return (await res.json()).claim_url;
  }

  it("serves the install command and the token", async () => {
    const body = await (await handleRequest(new Request(await mintClaimUrl()), env, undefined)).text();
    expect(body).toMatch(/reposkein-mcp support rsk1\./);
    expect(body).toMatch(/no\s*\n?network call is made/);
  });

  it("404s an unknown or malformed code without saying which", async () => {
    for (const path of ["/claim/short", `/claim/${"A".repeat(43)}`]) {
      const res = await handleRequest(new Request(`https://kofi.example.test${path}`), env, undefined);
      expect(res.status, path).toBe(404);
      // Identical body for "too short to be a code" and "a well-formed code
      // I have never seen": a prober learns nothing from the difference.
      expect(await res.text()).toBe("Unknown or expired claim link.");
    }
  });

  it("cannot be walked out of with a traversal code", async () => {
    // URL normalisation resolves this before routing, so it never even
    // reaches the claim handler — but assert it, because "the runtime happens
    // to normalise for us" is exactly the kind of assumption that changes.
    const res = await handleRequest(
      new Request("https://kofi.example.test/claim/../../etc/passwd"),
      env,
      undefined
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("rsk1.");
  });

  it("expires after CLAIM_MAX_READS opens", async () => {
    const url = await mintClaimUrl();
    for (let i = 0; i < 3; i++) {
      expect((await handleRequest(new Request(url), env, undefined)).status, `read ${i + 1}`).toBe(200);
    }
    expect((await handleRequest(new Request(url), env, undefined)).status).toBe(404);
  });

  it("counts down the remaining opens for the reader", async () => {
    const url = await mintClaimUrl();
    expect(await (await handleRequest(new Request(url), env, undefined)).text()).toMatch(/2 more times/);
    expect(await (await handleRequest(new Request(url), env, undefined)).text()).toMatch(/1 more time\./);
    expect(await (await handleRequest(new Request(url), env, undefined)).text()).toMatch(/used up/);
  });

  it("does not extend the claim's lifetime by being opened", async () => {
    const url = await mintClaimUrl();
    const key = [...kv.ttls.keys()].find((k) => k.startsWith("claim:"))!;
    const original = kv.ttls.get(key)!;
    await handleRequest(new Request(url), env, undefined);
    // Re-put carries the REMAINING window, never a fresh one.
    expect(kv.ttls.get(key)!).toBeLessThanOrEqual(original);
  });

  it("404s a claim record that has lost its token", async () => {
    const url = await mintClaimUrl();
    const key = [...kv.store.keys()].find((k) => k.startsWith("claim:"))!;
    kv.store.set(key, JSON.stringify({ reads: 0, maxReads: 3 }));
    const res = await handleRequest(new Request(url), env, undefined);
    expect(res.status).toBe(404);
  });

  describe("CLAIM_MAX_READS parsing", () => {
    async function readsBeforeGone(overrides: Record<string, unknown>): Promise<number> {
      const localKv = new FakeKV();
      const localEnv = { ...env, ...overrides, SUPPORTER_CLAIMS: localKv };
      const res = await handleKofiWebhook(kofiRequest(membershipPayload()), localEnv);
      const url = (await res.json()).claim_url;
      let ok = 0;
      for (let i = 0; i < 8; i++) {
        const r = await handleRequest(new Request(url), localEnv, undefined);
        if (r.status !== 200) break;
        ok++;
      }
      return ok;
    }

    it("honours a whole number", async () => {
      expect(await readsBeforeGone({ CLAIM_MAX_READS: "2" })).toBe(2);
    });

    it("floors a fractional value rather than rounding up", async () => {
      // 2.9 reads is not a thing; it must not silently become 3.
      expect(await readsBeforeGone({ CLAIM_MAX_READS: "2.9" })).toBe(2);
    });

    it("never produces a link that is dead on arrival", async () => {
      // `0`, `0.4` and a negative would all floor or round to zero, which
      // would delete the claim on the first read while still serving it —
      // or, worse, hand out a link nobody can use.
      for (const value of ["0", "0.4", "-5"]) {
        expect(await readsBeforeGone({ CLAIM_MAX_READS: value }), value).toBeGreaterThanOrEqual(1);
      }
    });

    it("falls back to the default for a non-numeric value", async () => {
      expect(await readsBeforeGone({ CLAIM_MAX_READS: "three" })).toBe(3);
      expect(await readsBeforeGone({ CLAIM_MAX_READS: "NaN" })).toBe(3);
    });

    it("survives a hand-mangled maxReads in the stored record", async () => {
      const url = await mintClaimUrl();
      const key = [...kv.store.keys()].find((k) => k.startsWith("claim:"))!;
      const record = JSON.parse(kv.store.get(key)!);
      kv.store.set(key, JSON.stringify({ ...record, maxReads: -1, reads: "banana" }));
      // Still serves once and then closes, rather than treating a negative
      // cap as "never expire".
      expect((await handleRequest(new Request(url), env, undefined)).status).toBe(200);
      expect((await handleRequest(new Request(url), env, undefined)).status).toBe(404);
    });
  });
});

describe("routing", () => {
  it("answers /health", async () => {
    const res = await handleRequest(new Request("https://kofi.example.test/health"), env, undefined);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("405s a GET on the webhook route", async () => {
    const res = await handleRequest(new Request("https://kofi.example.test/kofi"), env, undefined);
    expect(res.status).toBe(405);
  });

  it("404s anything else", async () => {
    const res = await handleRequest(new Request("https://kofi.example.test/admin"), env, undefined);
    expect(res.status).toBe(404);
  });

  it("accepts the webhook at /, /kofi and /webhook", async () => {
    for (const path of ["/", "/kofi", "/webhook"]) {
      const res = await handleRequest(
        kofiRequest(membershipPayload({ message_id: `m${path}` }), `https://kofi.example.test${path}`),
        env,
        undefined
      );
      expect(res.status, path).toBe(200);
    }
  });

  it("defers the maintainer notification with waitUntil when a ctx is present", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    const deferred: Promise<unknown>[] = [];
    await handleRequest(kofiRequest(membershipPayload()), { ...env, NOTIFY_WEBHOOK_URL: "https://n.example.test" }, {
      waitUntil: (p: Promise<unknown>) => void deferred.push(p),
    });
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
