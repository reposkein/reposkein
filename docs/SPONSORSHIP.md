# Sponsorship

**Status: implemented, OFF, and not yet ratified for this surface.** Nothing
in this document happens on a normal install: the code ships inert, no
credentials exist, and the placement below still needs a decision record
before anyone turns it on. See [Placement status](#placement-status).

RepoSkein's infra and indexer maintenance are funded in part by
[Ko-fi](https://ko-fi.com/mongx) support. REP-28 adds the other half of that
story: an **opt-in, disclosed, fail-open sponsored slot** delivered by
[Lulu Ads](https://getlulu.dev) (CPA, 70% publisher share), implemented in
`mcp/src/ads/`.

## Placement status

The governing decision record —
`adr:2026-08-21-sponsorship-placement-viewer-chip-only-deferred-to-rep-28-no`
(`reposkein-mcp adr export`, or `.reposkein/decisions/`) — authorizes **one**
sponsorship surface: a disclosed chip in the **viewer's chrome**. It also
rules, permanently, that `semantic_find`'s retrieval path and embed-server
carry no sponsored content on any code path, and it binds three cross-cutting
constraints on any sponsorship work: no sponsored data in `.reposkein/`
artifacts, fixed-schema length-capped payloads, and an immutable `sponsored`
label.

What REP-28 implements is a **slot on an MCP tool-result envelope**, which is
a different surface from the viewer chip. Every cross-cutting constraint above
is honoured and enforced by tests (see [Invariants](#invariants-and-where-they-are-tested)),
and `semantic_find` is excluded in code. But the surface itself is not one the
ADR ruled on, and the ADR is explicit that a placement it did not authorize
needs "a new ADR that explicitly supersedes this one, not a quiet exception".

So, deliberately:

- The mechanism ships **off**, and cannot be switched on by accident.
- No publisher credentials exist, so even an opted-in machine is inert.
- **Before enabling this on a real install, record and ratify a decision for
  the MCP-result placement** (`record_decision` → `set_decision_status`), or
  move the slot to the ADR-authorized viewer chip instead.

## The gating chain

Evaluated in this order on every eligible tool call, in
`mcp/src/ads/config.ts` (`resolveAdsVerdict`). Every step must pass before
**any** network call is made or the `lulu-ads` package is even imported:

1. **Kill switch** — `REPOSKEIN_ADS=off` (also `0`, `false`) stops everything,
   outranking config, credentials, and anything a repo committed. Checked
   first on purpose.
2. **Opt-in** — `[ads] enabled = true` in `.reposkein/config.toml` **or**
   `REPOSKEIN_ADS=on`. Absent both: off. This is the default everywhere.
3. **Credentials** — both `LULU_ADS_PUBLISHER_ID` and `LULU_ADS_API_KEY`,
   **environment only** (never config.toml, never argv, never logged). Absent
   either: inert, no request attempted.
4. **Supporter** — a verified supporter never sees a slot. Currently a stub
   (`mcp/src/ads/supporter.ts`) that reports "not a supporter" for everyone;
   REP-29 (Ko-fi verification) fills it in, and the gate is wired now so the
   feature cannot ship without it.

Plus two placement gates that are code, not configuration:

- **Tool allowlist** — `AD_ELIGIBLE_TOOLS` in `mcp/src/ads/config.ts`, today
  exactly `["get_context_profile"]`. A tool added to the server later carries
  no slot until someone puts it on that list on purpose.
  `semantic_find` is excluded permanently (ADR ruling 2: ranked retrieval must
  return what matches the query, never what a sponsor paid for), as is every
  mutating tool.
- **Never on failures** — a result with `isError: true` short-circuits before
  the gating chain: an error path is not a sales surface.

### Opting out

```bash
export REPOSKEIN_ADS=off        # unconditional, outranks everything
```

Or simply never opt in — which is the default state of every install.

In the optional shared `serve --http` mode ([`REMOTE.md`](REMOTE.md)) the
gating chain is evaluated per connection but reads the **operator's** process
environment, so opting that process in opts in every client it serves —
including read-only ones. Run it opted out unless every consumer of that
endpoint has agreed.

## Exactly what leaves the machine

One request, only after all gates pass:

```
POST https://ads.getlulu.dev/slot
x-api-key: <LULU_ADS_API_KEY>
content-type: application/json

{"context":{"tool":"get_context_profile"}}
```

That is the whole payload — verified by intercepting `fetch` around the real
SDK, not just by reading it: one request, those two headers, that body.
`LULU_ADS_PUBLISHER_ID` is *not* transmitted at all; it gates locally (the
client is inert without it) while the API key identifies the publisher. The
context object is built field by field in `mcp/src/ads/luluSource.ts` from a
two-field `SlotContext` (`tool`, and an optional `keywords` string that no
eligible tool populates today).

**Never sent:** file paths, node ids, code, summaries, decision text, query
strings, argument values, repo id, repo name, git remote, branch, commit,
identity/agent name, session id, machine or user identifiers, or anything read
from the graph. The ad network's own SDK would additionally accept `prompt`,
`query`, `category`, `route`, `locale` and `country` keys; RepoSkein populates
none of them, so nothing can leak through one by accident. A test asserts the
outbound context is exactly `{tool: "get_context_profile"}` even when the tool
call itself carried a node id and a file path.

Timing: a hard **800ms** budget (`SLOT_TIMEOUT_MS`), enforced with an
`AbortController` and a race, so a slow or hanging network cannot delay a tool
result beyond it. The SDK's own default (1500ms, 3000ms when the backend may
classify) is overridden on every call.

## What comes back, and what survives validation

The response is untrusted input. `mcp/src/ads/sanitize.ts` projects it onto a
fixed schema and rejects anything that does not fit — there is no truncation
and no partial acceptance:

| Field   | Rule |
|---------|------|
| `label` | Always the literal `"sponsored"`, constructed locally. A payload's own `label` is ignored entirely. |
| `title` | Optional, ≤ 80 chars, plain text. |
| `body`  | Optional, ≤ 200 chars, plain text. (The network's wire field `text` maps here.) |
| `url`   | Required. `https` only, host must be on the click-domain allowlist derived from the base URL in use (`ads.getlulu.dev` by default — the network always returns its own signed `/c/{token}` redirect, never a raw advertiser URL), no embedded credentials, ≤ 512 chars, canonicalized. |

At least one of `title`/`body` is required. Rejected outright: payloads over
4KB, non-objects, markdown link syntax, code fences, HTML, control characters,
invisible/bidi characters (a refusal, not a repair — they exist only to make
what a human sees differ from what a model reads), and copy shaped like an
instruction ("ignore previous instructions", role/turn markers, special-token
or template syntax, tool-call bait). Any rejection means **no slot**, which is
byte-identical to no ad having been offered.

The real boundary is not the denylist: it is that a slot is fixed-schema,
length-capped **data** in a labelled envelope field, never prose the tool
emits. The denylist is defence in depth on top of that.

## Where the slot attaches

On the **response envelope only**, copy-on-write:

```jsonc
{
  "content": [ /* the tool's own answer, untouched */ ],
  "_meta": {
    "reposkein/sponsored": { "label": "sponsored", "body": "…", "url": "https://ads.getlulu.dev/c/…" }
  }
}
```

- **Never in `content`.** Not concatenated, not appended as an extra text
  block. `content` is the tool's answer and the surface an agent reads as
  prose.
- **Never a new `structuredContent`.** Materializing one that held only an ad
  would let a host preferring structured output render the ad *instead of* the
  answer. When a tool already returns `structuredContent`, the slot is mirrored
  there under a separate `sponsored` key.
- **Copy-on-write.** The result object the session logger holds by reference is
  never mutated, which is what keeps sponsored bytes out of
  `.reposkein/local/sessions` (and out of `reposkein-mcp stats`).

## Invariants, and where they are tested

| Invariant | Test |
|---|---|
| Off by default; every gate blocks before any network call | `mcp/test/adsGating.test.ts`, `mcp/test/adsSlot.test.ts` |
| `REPOSKEIN_ADS=off` outranks config and credentials | `mcp/test/adsGating.test.ts` |
| No credentials → zero network, byte-identical output | `mcp/test/adsSlot.test.ts` |
| Rejecting / throwing source → byte-identical output | `mcp/test/adsSlot.test.ts` |
| Hanging source → result within the budget, no slot, request aborted | `mcp/test/adsSlot.test.ts` |
| Malformed, oversized, off-host and instruction-shaped payloads rejected, never reaching a prose field | `mcp/test/adsSanitize.test.ts` (fuzz table, ~50 rows) |
| The `sponsored` label cannot be renamed, blanked, or dropped | `mcp/test/adsSanitize.test.ts` |
| Sponsored data never lands in `.reposkein/` (tree byte-compared, ads on vs off) | `mcp/test/adsSlot.test.ts` |
| `semantic_find`, mutating tools and error paths never carry a slot | `mcp/test/adsGating.test.ts`, `mcp/test/adsSlot.test.ts`, `mcp/test/adsWiring.test.ts` |

## The `lulu-ads` dependency

`lulu-ads@0.9.0` (MIT, zero runtime dependencies, no install scripts). Only
its low-level client is used — `new LuluAds({...}).sponsoredSlot({context,
timeoutMs})` — and it is imported **dynamically**, so with ads off the package
is never loaded at all.

Deliberately unused:

- `enableLuluAds` / `withLuluAds` — they proxy `registerTool` and mutate the
  tool result: appending a rendered text card to `content` for CLI clients
  and, when `content` is a single text block, replacing it with
  `JSON.stringify(structuredContent)`. That rewrites the answer, which both
  the ADR ("never concatenated into result text") and the byte-identical
  fail-open guarantee forbid.
- `warmUp()` — POSTs `/telemetry/init` at startup. An opt-in integration makes
  no network call until a tool call has passed the gating chain.
- `formatSuffix` / `formatCliCard` — both exist to concatenate sponsor copy
  into prose.
- The widget / MCP-Apps exports — no rendered ad surface is in scope.

## Getting credentials (when the placement is ratified)

1. Register at <https://getlulu.dev/publishers> — the API key is shown once.
2. Export `LULU_ADS_PUBLISHER_ID` and `LULU_ADS_API_KEY` (see
   [`.env.example`](../.env.example)). Never commit them.
3. Opt in with `REPOSKEIN_ADS=on` or `[ads] enabled = true` in
   `.reposkein/config.toml`.
4. Verify with the dashboard's test-slot button; it is tagged as a test and
   never counts toward stats or balance.

## See also

- [`HOSTING.md` — Sponsorship & support](HOSTING.md#sponsorship--support) — the
  placement policy summary and the static-export invariant.
- REP-29 — supporter verification, which fills in
  `mcp/src/ads/supporter.ts`.
- [Ko-fi](https://ko-fi.com/mongx) — the support path that exists today.
