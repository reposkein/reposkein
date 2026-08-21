/** Ko-fi → supporter-token fulfilment.
 *
 *  ## What this is, and what it is not
 *
 *  OUR infrastructure, entirely optional, and no user-facing RepoSkein
 *  feature depends on it. `reposkein-mcp support` verifies a token offline
 *  against a committed public key; where that token came from is this
 *  worker's problem and nobody else's. If this worker is down, deleted, or
 *  never deployed, every already-issued token keeps working forever (until
 *  its own expiry). That asymmetry is the point.
 *
 *  ## The honest delivery story
 *
 *  Ko-fi's webhook is fire-and-forget: it POSTs to a URL and ignores the
 *  response body. There is no Ko-fi API to send the supporter a message, and
 *  Ko-fi will not email a token on our behalf. So a webhook alone CANNOT
 *  deliver anything to the person who just paid. Anyone claiming otherwise
 *  has not read the docs.
 *
 *  What this worker does instead:
 *
 *   1. The webhook mints the token and parks it behind a one-time claim code
 *      (32 random bytes) in KV.
 *   2. If `NOTIFY_WEBHOOK_URL` is configured (a Discord/Slack incoming
 *      webhook), the claim URL is pushed there along with the supporter's
 *      Ko-fi display name, so the maintainer can send it via Ko-fi's own
 *      supporter DM. Manual, but it is one paste, and it is honest about the
 *      fact that a human is in the loop.
 *   3. The supporter opens the claim URL and copies the
 *      `reposkein-mcp support <token>` line off it.
 *
 *  What was deliberately NOT built: a `GET /claim?email=…` lookup. It reads
 *  as the obvious self-service fix and it is an oracle — anyone who guesses
 *  a supporter's email address gets their token, and gets to confirm that the
 *  address supports RepoSkein. An unguessable code handed over out of band is
 *  the only version of this that is not a data leak.
 *
 *  ## Idempotency
 *
 *  Ko-fi retries webhooks. `message_id` is remembered so a retry returns the
 *  SAME claim URL rather than minting a second token and stranding the first
 *  notification. */

import { constantTimeEquals, mintSupporterToken, newClaimCode, opaqueSubject } from "./token.js";

/** Every tunable and its default, in one object.
 *
 *  Exported because `mcp/test/kofiWorker.test.ts` cross-checks it against the
 *  verifier: `SUPPORTER_KID` must name a key the shipped package actually
 *  trusts, and `TOKEN_TTL_DAYS` must fit inside the verifier's lifetime cap.
 *  A mismatch in either is the worst bug this system can have — the money is
 *  taken and the token is then rejected by every client — so it is asserted
 *  rather than left to a careful reader. */
export const DEFAULTS = {
  SUPPORTER_KID: "skein-2026-08",
  KOFI_TIER_NAME: "Skein",
  TOKEN_TTL_DAYS: "35",
  CLAIM_TTL_DAYS: "30",
  CLAIM_MAX_READS: "3",
};

/** @param {Record<string, unknown>} env @param {keyof DEFAULTS} name */
function setting(env, name) {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : DEFAULTS[name];
}

/** A numeric setting, falling back to the default when the configured value
 *  is not a positive finite number. Without this a typo in `TOKEN_TTL_DAYS`
 *  produces `exp: null` in the payload and every token the worker mints is
 *  rejected by every client — a failure that would only surface as
 *  "supporters say it does not work".
 *  @param {Record<string, unknown>} env @param {keyof DEFAULTS} name */
function numberSetting(env, name) {
  const parsed = Number(setting(env, name));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Number(DEFAULTS[name]);
}

/** A whole-number setting with a floor. Counts have to be integers — a
 *  `CLAIM_MAX_READS` of `2.5` compared against an integer read counter is a
 *  slow way to write `2`, and `0.4` would round to zero and hand out a claim
 *  link that is dead the instant it is created. NaN and non-positive values
 *  are already rejected by `numberSetting`; this adds truncation and the
 *  minimum.
 *  @param {Record<string, unknown>} env @param {keyof DEFAULTS} name @param {number} min */
function intSetting(env, name, min = 1) {
  return Math.max(min, Math.floor(numberSetting(env, name)));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Router. Kept tiny and dependency-free so the worker needs no build step:
 *  wrangler uploads these `.js` modules as they are.
 *
 *  @param {Request} request
 *  @param {Record<string, any>} env
 *  @param {{waitUntil?: (p: Promise<unknown>) => void}} [ctx] */
export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") return json({ ok: true });

  if (path === "/" || path === "/kofi" || path === "/webhook") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    return handleKofiWebhook(request, env, ctx);
  }

  if (path.startsWith("/claim/")) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return handleClaim(path.slice("/claim/".length), env);
  }

  return json({ error: "not_found" }, 404);
}

/** @param {Request} request @param {Record<string, any>} env @param {{waitUntil?: Function}} [ctx] */
export async function handleKofiWebhook(request, env, ctx) {
  if (typeof env.KOFI_WEBHOOK_TOKEN !== "string" || env.KOFI_WEBHOOK_TOKEN === "") {
    // Misconfiguration must never degrade into "accept everything".
    return json({ error: "server_misconfigured" }, 500);
  }

  let payload;
  try {
    const form = await request.formData();
    const raw = form.get("data");
    if (typeof raw !== "string") return json({ error: "missing_data_field" }, 400);
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!payload || typeof payload !== "object") return json({ error: "bad_request" }, 400);

  const supplied = typeof payload.verification_token === "string" ? payload.verification_token : "";
  if (!(await constantTimeEquals(supplied, env.KOFI_WEBHOOK_TOKEN))) {
    // 401 with no detail: an attacker probing the endpoint learns only that
    // it rejected them, never whether the token was close.
    return json({ error: "unauthorized" }, 401);
  }

  // --- From here on the request is authentic. ---

  const wantedTier = setting(env, "KOFI_TIER_NAME").toLowerCase();
  const tierName = typeof payload.tier_name === "string" ? payload.tier_name.trim().toLowerCase() : "";
  const isSubscription = payload.is_subscription_payment === true;
  if (!isSubscription || tierName !== wantedTier) {
    // A one-off donation, a shop order, or a different membership tier. All
    // are genuine support and none of them is the entitlement being sold, so
    // the correct behaviour is to acknowledge and do nothing. 200, because a
    // non-2xx would make Ko-fi retry an event we will keep ignoring.
    return json({ ok: true, ignored: true, reason: !isSubscription ? "not_a_subscription_payment" : "other_tier" });
  }

  if (!env.SUPPORTER_CLAIMS) return json({ error: "server_misconfigured" }, 500);
  if (typeof env.SUPPORTER_SIGNING_KEY !== "string" || env.SUPPORTER_SIGNING_KEY === "") {
    return json({ error: "server_misconfigured" }, 500);
  }
  if (typeof env.SUBJECT_SALT !== "string" || env.SUBJECT_SALT === "") {
    return json({ error: "server_misconfigured" }, 500);
  }

  const messageId = typeof payload.message_id === "string" ? payload.message_id : "";
  const claimTtlSeconds = Math.round(numberSetting(env, "CLAIM_TTL_DAYS") * 24 * 60 * 60);

  // Ko-fi retries. Return the claim already minted for this message rather
  // than issuing a second token nobody was told about.
  if (messageId) {
    const existing = await env.SUPPORTER_CLAIMS.get(`msg:${messageId}`);
    if (existing) return json({ ok: true, duplicate: true, claim_url: claimUrl(env, request, existing) });
  }

  // Identity for the opaque subject: the email when Ko-fi supplies one (it
  // does for memberships), else the transaction id — which still gives a
  // stable-per-payment value, just not a stable-per-person one.
  const identity =
    (typeof payload.email === "string" && payload.email.trim() !== "" && payload.email) ||
    (typeof payload.kofi_transaction_id === "string" && payload.kofi_transaction_id) ||
    messageId;
  if (!identity) return json({ error: "no_identity" }, 400);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlDays = numberSetting(env, "TOKEN_TTL_DAYS");
  const sub = await opaqueSubject(identity, env.SUBJECT_SALT);
  const token = await mintSupporterToken(
    {
      sub,
      kid: setting(env, "SUPPORTER_KID"),
      iat: nowSeconds,
      // A membership renews monthly; the token outlives one billing cycle by
      // a few days so a late payment does not create a gap the client's own
      // grace period then has to absorb on its own.
      exp: nowSeconds + Math.round(ttlDays * 24 * 60 * 60),
    },
    env.SUPPORTER_SIGNING_KEY
  );

  const code = newClaimCode();
  const maxReads = intSetting(env, "CLAIM_MAX_READS", 1);
  // `expiresAt` is stored so a read can re-put the record with the REMAINING
  // lifetime instead of a fresh full TTL. Without it, opening the link once a
  // day would keep it alive indefinitely.
  const record = { token, reads: 0, maxReads, expiresAt: Date.now() + claimTtlSeconds * 1000 };
  await env.SUPPORTER_CLAIMS.put(`claim:${code}`, JSON.stringify(record), { expirationTtl: claimTtlSeconds });
  if (messageId) {
    await env.SUPPORTER_CLAIMS.put(`msg:${messageId}`, code, { expirationTtl: claimTtlSeconds });
  }

  const link = claimUrl(env, request, code);
  const notify = notifyMaintainer(env, payload, code);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(notify);
  else await notify;

  return json({ ok: true, claim_url: link });
}

/** @param {Record<string, any>} env @param {Request} request @param {string} code */
function claimUrl(env, request, code) {
  const base =
    typeof env.PUBLIC_BASE_URL === "string" && env.PUBLIC_BASE_URL.trim() !== ""
      ? env.PUBLIC_BASE_URL.trim().replace(/\/+$/, "")
      : new URL(request.url).origin;
  return `${base}/claim/${code}`;
}

/** Best-effort nudge to wherever the maintainer watches.
 *
 *  ## Why this sends a CODE and never a URL
 *
 *  Discord and Slack fetch every link posted to them in order to build a
 *  preview. That fetch is a GET against the claim endpoint, which would
 *  (a) burn one of the supporter's limited reads before they have seen the
 *  link at all, and (b) hand the token itself to the platform's link-preview
 *  crawler, which stores and caches page content. Posting the URL would mean
 *  the token is read by a third party every single time — not an edge case,
 *  the default behaviour.
 *
 *  So the message carries the bare claim CODE and no link. There is nothing
 *  in it for an unfurler to follow, because there is no URL in it. The
 *  maintainer knows their own worker's address and assembles the link when
 *  they send it on.
 *
 *  Never throws: a notification failure must not turn an authentic, already
 *  paid-for webhook into a retry storm.
 *
 *  @param {Record<string, any>} env
 *  @param {Record<string, any>} payload
 *  @param {string} code */
async function notifyMaintainer(env, payload, code) {
  if (typeof env.NOTIFY_WEBHOOK_URL !== "string" || env.NOTIFY_WEBHOOK_URL === "") return;
  const who = typeof payload.from_name === "string" ? payload.from_name : "a supporter";
  const first = payload.is_first_subscription_payment === true ? "NEW" : "renewal";
  // Deliberately no email address: the maintainer replies through Ko-fi's own
  // supporter DM, so there is no reason to copy a customer email into a chat
  // log that will outlive the subscription. And deliberately no URL — see
  // above.
  const message =
    `RepoSkein Skein membership (${first}) from ${who}.\n` +
    `Claim code (append to /claim/ on the fulfilment worker): ${code}\n` +
    `Send it as the full link in a Ko-fi supporter DM. Do not paste the link ` +
    `anywhere a preview bot will fetch it — that spends a read and shows the ` +
    `token to the crawler.`;
  try {
    await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `content` is Discord's field, `text` is Slack's. Sending both means
      // one endpoint URL works for either without configuration; the extra
      // key is ignored by whichever platform did not ask for it. Slack
      // rejects a body with no `text` outright (and does so with a 200-shaped
      // error that is easy to miss), which is the failure this avoids.
      body: JSON.stringify({ content: message, text: message }),
    });
  } catch {
    // Swallowed on purpose.
  }
}

/** One-time-ish claim. `CLAIM_MAX_READS` (default 3) rather than strict
 *  delete-on-read: a supporter who refreshes the page or opens the link on a
 *  second device should not be locked out of something they paid for, and a
 *  code that only the recipient has seen is not made materially weaker by
 *  tolerating two extra fetches.
 *
 *  The read counter is best-effort, not a hard limit: KV is eventually
 *  consistent, so two simultaneous opens can both see the same count. That is
 *  acceptable precisely because the cap is a courtesy rather than a security
 *  boundary — the unguessable code is the security boundary.
 *
 *  @param {string} code @param {Record<string, any>} env */
export async function handleClaim(code, env) {
  if (!env.SUPPORTER_CLAIMS) return json({ error: "server_misconfigured" }, 500);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return text("Unknown or expired claim link.", 404);

  const raw = await env.SUPPORTER_CLAIMS.get(`claim:${code}`);
  if (!raw) return text("Unknown or expired claim link.", 404);

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return text("Unknown or expired claim link.", 404);
  }
  if (typeof record?.token !== "string") return text("Unknown or expired claim link.", 404);

  // Both counters are re-derived defensively: the record came out of KV, and
  // a hand-edited or half-written one must not produce a fractional or
  // negative cap that the `>=` below then reads as "never expire".
  const reads = Math.max(0, Math.floor(Number(record.reads)) || 0) + 1;
  const maxReads = Math.max(1, Math.floor(Number(record.maxReads)) || 3);
  if (reads >= maxReads) {
    await env.SUPPORTER_CLAIMS.delete(`claim:${code}`);
  } else {
    // Re-put with what is LEFT of the original window, never a fresh one.
    const remainingMs = Number(record.expiresAt) - Date.now();
    const remainingTtl = Number.isFinite(remainingMs) ? Math.max(60, Math.round(remainingMs / 1000)) : 60 * 60 * 24;
    await env.SUPPORTER_CLAIMS.put(`claim:${code}`, JSON.stringify({ ...record, reads }), {
      expirationTtl: remainingTtl,
    });
  }

  const remaining = Math.max(0, maxReads - reads);
  return text(
    [
      "Thank you for supporting RepoSkein.",
      "",
      "Install your supporter token with:",
      "",
      `  reposkein-mcp support ${record.token}`,
      "",
      "It is verified locally against a public key baked into the package — no",
      "network call is made, now or ever. Check it any time with",
      "`reposkein-mcp support --status`, and remove it with",
      "`reposkein-mcp support --remove`.",
      "",
      remaining > 0
        ? `This link can be opened ${remaining} more time${remaining === 1 ? "" : "s"}.`
        : "This link has now been used up. Save the token somewhere safe.",
      "",
    ].join("\n")
  );
}
