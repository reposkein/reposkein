# Sponsorship

**Status: built, OFF, and deliberately dormant.** The active sponsorship
surface is the **viewer chrome chip** (REP-30's record, still unbuilt) plus
[Ko-fi](https://ko-fi.com/mongx) support. The MCP tool-result slot this
document describes is recorded as `proposed` and, by decision, is **not to be
enabled now** — see [Placement](#placement). Nothing here happens on an
install that has not opted in *and* supplied credentials.

RepoSkein's infra and indexer maintenance are funded in part by Ko-fi support.
REP-28 built the other half of that story: an **opt-in, disclosed, fail-open
sponsored slot** delivered by [Lulu Ads](https://getlulu.dev) (CPA, 70%
publisher share), implemented in `mcp/src/ads/`.

## Placement

Two decision records govern sponsorship, and both are live
(`reposkein-mcp adr export`, or `.reposkein/decisions/`):

- `adr:2026-08-21-sponsorship-placement-viewer-chip-only-deferred-to-rep-28-no`
  (**accepted**) — what may **never** carry ads: embed-server and the
  `semantic_find` retrieval path, permanently and on every code path; no
  required ad container; static exports stay ad-free with no view-time-fetch
  exception. Plus the constraints binding every payload: no sponsored data in
  `.reposkein/` artifacts, fixed-schema length-capped copy, an immutable
  `sponsored` label. It also authorizes a disclosed chip in the **viewer
  chrome** — the active surface, still unbuilt.
- `adr:2026-08-21-mcp-tool-result-sponsored-slot-ratified-companion-to-the-vie`
  (**proposed, dormant**) — **records** the MCP tool-result slot this document
  describes and proposes the terms under which it could be enabled, without
  authorizing it. The standing ruling is not to ratify it now: a `_meta` field
  is machine-visible, so the hosts our users actually run (plain CLI agents)
  render it to nobody — zero revenue, and nonzero exposure from sponsor bytes
  sitting in an agent's context. Revisit when MCP Apps rendering is common in
  those hosts. Ratification is a human act (`set_decision_status`). Its id slug
  says "ratified" because a first draft asserted that; the status field and its
  body govern.

Read them together: the first for what is forbidden everywhere, the second for
this placement's terms and why it stays off. Every constraint is enforced in
code and covered by tests — see
[Invariants](#invariants-and-where-they-are-tested).

The machine-visibility limitation is recorded rather than designed around: a
plain CLI host renders no `_meta`, so there the disclosure reaches the model
and not the person. That is *not* a licence to move sponsor copy into prose, an
extra content block, or the tool's answer — all forbidden. The remedy for
human-visible disclosure is the viewer chip.

## The gating chain

Evaluated in this order on every eligible tool call, in
`mcp/src/ads/config.ts` (`resolveAdsVerdict`). Every step must pass before
**any** network call is made or the `lulu-ads` package is even imported:

1. **Kill switch** — `REPOSKEIN_ADS=off` (also `0`, `false`) stops everything,
   outranking config, credentials, and anything a repo committed. Checked
   first on purpose.
2. **Opt-in — the environment decides.** `REPOSKEIN_ADS=on` (also `1`, `true`)
   is required. A repo's `[ads] enabled = true` in `.reposkein/config.toml`
   *declares the repo's willingness* but never opts anyone in on its own:
   config.toml is committed and travels with every clone, so honouring it alone
   would let whoever wrote it opt in everybody who later checks the repo out.
   The environment is the only place the operator running *this* process speaks
   for themselves, so it has to confirm. A repo that asked without confirmation
   reports the distinct reason `config_not_confirmed`.
3. **Credentials** — both `LULU_ADS_PUBLISHER_ID` and `LULU_ADS_API_KEY`,
   **environment only** (never config.toml, never argv, never logged). Absent
   either: inert, no request attempted.
4. **Supporter** — a verified supporter never sees a slot. Currently a stub
   (`mcp/src/ads/supporter.ts`) that reports "not a supporter" for everyone;
   REP-29 (Ko-fi verification) fills it in, and the gate is wired now so the
   feature cannot ship without it.

| `[ads] enabled` | `REPOSKEIN_ADS` | Credentials | Result |
|---|---|---|---|
| anything | `off` | any | no slot (`kill_switch`) |
| absent/false | unset | any | no slot (`not_opted_in`) |
| `true` | unset | any | no slot (`config_not_confirmed`) |
| absent/false | `on` | missing | no slot (`no_credentials`) |
| absent/false | `on` | present | slot requested |
| `true` | `on` | present | slot requested |

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

### What the request reveals even though the body is tiny

The body names one tool and nothing else, but a request is still a request. The
ad network — and anyone able to observe the connection — necessarily learns:

- your **IP address**, and from it your approximate location and network;
- the **TLS SNI / host** (`ads.getlulu.dev`), which tells a network observer
  that this machine talks to an ad service, even though the body is encrypted;
- the **publisher API key**, which ties every request to one publisher account;
- the **cadence**: when calls happen and how often. Since the slot rides on
  `get_context_profile`, that is a coarse activity signal — roughly, when
  someone is doing code-navigation work and how intensely. Not what they were
  looking at, but that they were looking.

None of that can be removed by shrinking the payload; it is inherent to making
a network call at all. It is one of the reasons the slot is off by default and
the kill switch exists.

### The local request audit

Every outbound request appends one line to
`.reposkein/local/ads-requests.jsonl`:

```json
{"ts":"2026-08-21T20:15:04.001Z","tool":"get_context_profile"}
```

That is the whole record: when, and which tool. No response, no ad copy, no
URL, no credentials, no arguments — so the file can never become a place where
sponsor-supplied bytes accumulate. The line is written *before* the call, so a
request that then fails, times out, or is aborted still shows up. It lives
under `.reposkein/local/` (gitignored, outside the graph, alongside session
logs and caches), is never committed, and `doctor` never treats it as graph
state. Delete it whenever you like; nothing reads it but you.

It exists so an operator who opted in can verify the claims above after the
fact — "did this thing phone home, when, from which tool?" — without running a
proxy and without taking this document's word for it.

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
| Repo config alone never opts in; the environment must confirm | `mcp/test/adsGating.test.ts`, `mcp/test/adsSlot.test.ts` |
| No credentials → zero network, byte-identical output | `mcp/test/adsSlot.test.ts` |
| Rejecting / throwing source → byte-identical output | `mcp/test/adsSlot.test.ts` |
| Hanging source → result within the budget, no slot, request aborted | `mcp/test/adsSlot.test.ts` |
| Control characters (C0 **and** C1, incl. NEL) never survive into copy or a URL | `mcp/test/adsSanitize.test.ts` |
| Malformed, oversized, off-host and instruction-shaped payloads rejected, never reaching a prose field | `mcp/test/adsSanitize.test.ts` (fuzz table, ~50 rows) |
| One audit line per outbound request, `{ts, tool}` only, none when no request is made | `mcp/test/adsSlot.test.ts` |
| The `sponsored` label cannot be renamed, blanked, or dropped | `mcp/test/adsSanitize.test.ts` |
| Sponsored data never lands in `.reposkein/` (tree byte-compared, ads on vs off; the local audit counter is the one permitted difference and carries no sponsor bytes) | `mcp/test/adsSlot.test.ts` |
| `semantic_find`, mutating tools and error paths never carry a slot | `mcp/test/adsGating.test.ts`, `mcp/test/adsSlot.test.ts`, `mcp/test/adsWiring.test.ts` |

## The `lulu-ads` dependency

`lulu-ads@0.9.0` (MIT, zero runtime dependencies, no install scripts). Only
its low-level client is used — `new LuluAds({...}).sponsoredSlot({context,
timeoutMs})` — and it is imported **dynamically**, so with ads off the package
is never loaded at all.

It is a regular `dependency`, deliberately: `optionalDependencies` would trade
~280KB of never-executed code for a failure mode where an opted-in install
silently serves no slots because the package isn't there. Inert-but-present is
easier to reason about than absent-and-quiet.

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

## Getting credentials (if the placement is ever ratified)

The record for this placement is `proposed` and the standing ruling is not to
enable it, so this section is a reference, not an invitation. Ratify the
record first (`set_decision_status`), then:

1. Register at <https://getlulu.dev/publishers> — the API key is shown once.
2. Export `LULU_ADS_PUBLISHER_ID` and `LULU_ADS_API_KEY` (see
   [`.env.example`](../.env.example)). Never commit them.
3. Opt in with `REPOSKEIN_ADS=on` in the environment (a repo's
   `[ads] enabled = true` is a declaration, not an opt-in — see the gating
   table).
4. Verify with the dashboard's test-slot button; it is tagged as a test and
   never counts toward stats or balance. Then check
   `.reposkein/local/ads-requests.jsonl` to see the request from this side.

## See also

- [`HOSTING.md` — Sponsorship & support](HOSTING.md#sponsorship--support) — the
  placement policy summary and the static-export invariant.
- REP-29 — supporter verification, which fills in
  `mcp/src/ads/supporter.ts`.
- [Ko-fi](https://ko-fi.com/mongx) — the support path that exists today.
