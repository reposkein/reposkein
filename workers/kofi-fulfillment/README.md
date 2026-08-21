# Ko-fi fulfilment worker

Mints RepoSkein **supporter tokens** when a Ko-fi *Skein* membership payment
arrives, and hands them over through a one-time claim link.

This is **our infrastructure, and it is optional.** No RepoSkein feature
depends on it. `reposkein-mcp support` verifies a token offline against a
public key compiled into the published package, so a token issued once keeps
working whether or not this worker is running — or has ever been deployed.
If you are reading this because you cloned RepoSkein, you almost certainly do
not need to deploy it.

- Verifier: [`mcp/src/ads/supporterToken.ts`](../../mcp/src/ads/supporterToken.ts)
- Public key: [`mcp/src/ads/supporterKey.ts`](../../mcp/src/ads/supporterKey.ts)
- User-facing docs: [`docs/SPONSORSHIP.md`](../../docs/SPONSORSHIP.md)

## How delivery actually works

Ko-fi's webhook is fire-and-forget. It POSTs to a URL and **ignores the
response body**, there is no Ko-fi API for sending a supporter a message, and
Ko-fi will not email anything on your behalf. A webhook therefore *cannot*
deliver a token to the person who just paid. Any design that claims otherwise
is wrong about Ko-fi.

So the flow has a human in it, and says so:

```
Ko-fi membership payment
        │
        ▼  POST (form-encoded, field `data`)
  /kofi  ── verify KOFI_WEBHOOK_TOKEN (constant-time)
        ── is_subscription_payment && tier_name == "Skein"?  no → 200, ignored
        ── mint Ed25519 token, park it in KV behind a 32-byte claim code
        ── POST the claim link to NOTIFY_WEBHOOK_URL (Discord/Slack), optional
        │
        ▼
  maintainer pastes the claim link into Ko-fi's supporter DM
        │
        ▼
  supporter opens /claim/<code> → copies `reposkein-mcp support <token>`
```

**Why not a self-service `/claim?email=…`?** Because it is an oracle: anyone
who guesses a supporter's email gets their token *and* confirmation that the
address supports RepoSkein. An unguessable code delivered out of band is the
only version of this that is not a data leak.

If a fully automated path is wanted later, the honest options are (a) a Ko-fi
Shop digital-download product whose file is a link to a claim page, or (b)
collecting an email explicitly with consent and sending it yourself. Both are
more moving parts than a monthly paste, which is why neither is here yet.

## Endpoints

| Route | Method | Behaviour |
|---|---|---|
| `/`, `/kofi`, `/webhook` | POST | Ko-fi webhook. 401 on a bad verification token, 200 + `{"ignored":true}` for non-membership events, 200 + `{"claim_url":…}` on a mint. |
| `/claim/<code>` | GET | Plain-text page with the token and the install command. Openable `CLAIM_MAX_READS` times (default 3), then gone. |
| `/health` | GET | `{"ok":true}`. |

Retries are safe: `message_id` is remembered, so a repeated webhook returns the
same claim URL instead of minting a second token.

## Deploying

Prerequisites: a Cloudflare account and `npx wrangler` (no local install and
**no build step** — `src/*.js` are plain ES modules that wrangler uploads
as-is).

### 1. Generate the signing keypair

Do this **once**, on a machine you trust:

```bash
node -e 'const{generateKeyPairSync}=require("crypto");
const{publicKey,privateKey}=generateKeyPairSync("ed25519");
console.log(publicKey.export({type:"spki",format:"pem"}).toString());
console.log(privateKey.export({type:"pkcs8",format:"der"}).toString("base64"))'
```

- The **PEM** goes into `SUPPORTER_PUBLIC_KEYS` in
  `mcp/src/ads/supporterKey.ts` under a new `kid`, and gets committed and
  published. Clients cannot verify a token signed by a key they do not ship.
- The **base64 line** is the private key. It goes into the Cloudflare secret
  store and nowhere else — not into git, not into `wrangler.toml`, not into a
  password-manager note that syncs somewhere you have not thought about.
  Anyone holding it can mint entitlement for every RepoSkein install.

### 2. Create the KV namespace

```bash
cd workers/kofi-fulfillment
npx wrangler kv namespace create SUPPORTER_CLAIMS
```

Paste the printed id into `wrangler.toml` (`id = "REPLACE_WITH_KV_NAMESPACE_ID"`).

### 3. Set the secrets

```bash
npx wrangler secret put KOFI_WEBHOOK_TOKEN     # Ko-fi → Settings → API
npx wrangler secret put SUPPORTER_SIGNING_KEY  # the base64 line from step 1
npx wrangler secret put SUBJECT_SALT           # openssl rand -base64 32
npx wrangler secret put NOTIFY_WEBHOOK_URL     # optional: Discord/Slack webhook
```

### 4. Deploy and register the webhook

```bash
npx wrangler deploy
```

Then in Ko-fi → **Settings → API**, set the webhook URL to
`https://<your-worker>.workers.dev/kofi` and copy the **verification token**
shown on that page into `KOFI_WEBHOOK_TOKEN` (step 3) if you have not already.

Finally, set `PUBLIC_BASE_URL` in `wrangler.toml` to the worker's real URL so
claim links are stable even behind a proxy that rewrites `Host`.

### 5. Verify

```bash
curl https://<your-worker>.workers.dev/health          # → {"ok":true}
curl -X POST https://<your-worker>.workers.dev/kofi \
  --data-urlencode 'data={"verification_token":"wrong","type":"Subscription"}'
                                                        # → 401
```

Ko-fi's settings page has a "send test" button; a test event with no
`tier_name` should come back `{"ok":true,"ignored":true}`.

## Configuration reference

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `KOFI_WEBHOOK_TOKEN` | secret | — | Ko-fi's verification token. Missing → every webhook 500s (never "accept everything"). |
| `SUPPORTER_SIGNING_KEY` | secret | — | Base64 PKCS#8 Ed25519 private key. |
| `SUBJECT_SALT` | secret | — | Salts the HMAC producing the token's opaque `sub`. |
| `NOTIFY_WEBHOOK_URL` | secret | — | Optional. Where claim links are announced. |
| `SUPPORTER_CLAIMS` | KV binding | — | Claim + idempotency storage. |
| `KOFI_TIER_NAME` | var | `Skein` | Membership tier that mints a token (case-insensitive). |
| `SUPPORTER_KID` | var | `skein-2026-08` | Key id written into minted tokens. |
| `TOKEN_TTL_DAYS` | var | `35` | Token lifetime. |
| `CLAIM_TTL_DAYS` | var | `30` | Claim-link lifetime. |
| `CLAIM_MAX_READS` | var | `3` | How many times a claim link may be opened. |
| `PUBLIC_BASE_URL` | var | request origin | Base for generated claim URLs. |

## Tests

The handler is a plain function over `(Request, env, ctx)`, so it is tested
from the MCP package's existing vitest run with an in-memory KV — no
miniflare, no second test runner, no `node_modules` in this directory:

```bash
cd mcp && npx vitest run test/kofiWorker.test.ts
```

Those tests mint with WebCrypto here and verify with `node:crypto` in
`mcp/src/ads/supporterToken.ts`, which is what keeps the two implementations
of the token format from drifting apart.

## Rotating the signing key

Additive first, subtractive later, or you strand paying supporters:

1. Generate a new pair; add the new **public** key to `SUPPORTER_PUBLIC_KEYS`
   under a new `kid`, keeping the old entry. Publish that release.
2. Once it is widely installed, point `SUPPORTER_KID` at the new key and
   update `SUPPORTER_SIGNING_KEY`. New tokens use the new key; old ones still
   verify.
3. After every token signed by the old key has expired (`TOKEN_TTL_DAYS` plus
   the client's 3-day grace), delete the old entry.

Skipping step 1 — or deleting the old key early — invalidates live
entitlements that people have paid for.
