# Remote MCP (advanced, optional)

> **This is an opt-in deployment mode, not part of normal use.** RepoSkein's
> default and supported transport is **stdio**: your agent launches
> `reposkein-mcp` as a subprocess on the machine that holds the checkout.
> Nothing in this document is required to use RepoSkein, and nothing binds a
> network socket unless you explicitly run `serve --http`.
>
> The decision to support this at all — and the scope boundaries it comes
> with — is recorded as an ADR in
> `.reposkein/decisions/2026-08-21-optional-shared-remote-mcp-server-hosted-multi-user-access-b.json`
> (`reposkein-mcp adr export .` to read it as prose).

## What it is

One process, one git checkout, two surfaces:

| Route | What it serves |
|---|---|
| `POST /mcp` | The MCP **Streamable HTTP** transport — tools, per connection |
| `DELETE /mcp` | Ends one MCP session |
| `GET /mcp` | `405` — there is no standalone notification stream; this server only ever answers what you asked for |
| `GET /api/graph` | The graph manifest (repo id, node/edge counts, commit metadata) |
| `GET /api/jsonl/nodes.jsonl`, `GET /api/jsonl/edges.jsonl` | The committed graph |
| `GET /api/source?path=&start=&end=` | A read-only, size-capped source slice |
| `GET /api/temporal` | The git-derived co-change overlay |
| `GET /` and everything else | The prebuilt constellation viewer (SPA) |

The `/api/*` routes are **not a reimplementation** — `serve` calls the same
handler factory `reposkein-mcp view` uses, so the hosted viewer and the remote
agent read the same graph by construction. A dedicated test asserts the
responses are identical.

Who it is for: a team that wants one always-current graph reachable by agents
that are *not* sitting on a clone — a CI job, a hosted coding agent, a reviewer
without the repo. If you have the repo locally, use stdio; it is faster, needs
no tokens, and has no attack surface.

## Quickstart

```bash
# 1. On the machine that holds the checkout, index it once.
cd /srv/checkouts/myrepo
npx @reposkein/mcp init .

# 2. Mint tokens. Names are identities, not secrets; the secret is the 2nd field.
#    Append `:write` to grant write tools. Read-only is the default.
export REPOSKEIN_SERVE_TOKENS="review-bot:$(openssl rand -hex 24),ci:$(openssl rand -hex 24):write"

# 3. Serve. --http is required and explicit.
npx @reposkein/mcp serve --http . --port 4318 --host 127.0.0.1
```

Point an agent at it (Claude Code example — any MCP client with Streamable
HTTP support works the same way):

```json
{
  "mcpServers": {
    "reposkein-remote": {
      "type": "http",
      "url": "https://reposkein.internal.example.com/mcp",
      "headers": { "Authorization": "Bearer <the token>" }
    }
  }
}
```

Open the hosted viewer in a browser by visiting
`https://reposkein.internal.example.com/?token=<the token>` **once**: the
server trades the query parameter for an `HttpOnly` cookie and redirects to the
clean URL, so the secret appears in one request line instead of every one.

## Flags

```
reposkein-mcp serve --http [path] [--port N] [--host H] [--watch-interval SECONDS]
```

| Flag | Default | Notes |
|---|---|---|
| `--http` | — | **Required.** The only transport this subcommand serves. Without it, `serve` prints usage and exits 1. |
| `[path]` | `$REPOSKEIN_REPO_PATH` or `.` | The one checkout this process serves. |
| `--port` | `4318` | |
| `--host` | `127.0.0.1` | Deliberately loopback even here — exposing the port is an explicit decision. |
| `--watch-interval` | `30` (seconds) | `0` disables the HEAD poll entirely. |

## Tokens and capabilities

A token is `name:secret[:write]`. Entries are separated by commas or
whitespace, so the same string pastes into a shell `export`, a systemd
`Environment=`, or a TOML value.

```
REPOSKEIN_SERVE_TOKENS="review-bot:8f3c…,ci:1a90…:write"
```

Because the format is delimited by `:` and entries by commas/whitespace, a
**secret may not contain `:`, `,`, or any whitespace** — an entry that does
splits wrong and is dropped with a reason on stderr rather than silently
becoming a partial credential. Hex and URL-safe base64 are both fine, which is
why the quickstart uses `openssl rand -hex 24`. Minimum length is 16
characters.

or, **for a private deployment only** (`.reposkein/config.toml` is committed —
putting a real secret there shares it with everyone who can read the repo):

```toml
[serve]
tokens = "review-bot:8f3c…, ci:1a90…:write"
```

`REPOSKEIN_SERVE_TOKENS` wins outright when set; the two sources are never
merged, so "why does this old token still work?" always has one answer.

- Secrets shorter than 16 characters are **dropped**, with a reason on stderr
  that never contains the secret itself.
- `serve` **refuses to start** with no usable tokens. An unauthenticated remote
  MCP server would hand the network read access to your source and, with a
  write-capable toolset, your decision log.
- A token's **name** is the writer identity for its connection. It lands in
  `summary_by` and `decided_by`, and selects that writer's
  `.reposkein/local/summaries-<name>.jsonl` sidecar — overriding
  `REPOSKEIN_AGENT`. This is why remote writes are attributable at all: over
  stdio, everything unlabelled is just `agent`.
- Attribution has one gap worth knowing: `set_decision_status` records only the
  decision's new status, not who changed it. The record's `decided_by` still
  names whoever *recorded* the decision, so a remote token ratifying someone
  else's ADR leaves no per-actor trace in the record itself — only a
  `set_decision_status` entry in that token's session log. Treat "who accepted
  this" as a session-log question, not a record question.

### Read-only by default

These tools require a `write`-capable token:

`write_semantic_summary` · `record_decision` · `set_decision_status` ·
`reaffirm_decision` · `reindex_file` · `init_cpg_skeleton`

They stay listed in `tools/list` for a read-only connection (with a note in the
description) so the failure is legible rather than a mysterious "unknown
tool" — but calling one changes nothing and returns a structured error:

```json
{
  "error": "write_capability_required",
  "tool": "record_decision",
  "required_capability": "write",
  "identity": "review-bot",
  "detail": "This connection is read-only, so record_decision was refused before it could change anything. …"
}
```

Everything else — `get_context_profile`, `semantic_find`, `impact`,
`get_temporal_context`, `list_decisions`, `get_decision`, `read_cypher`,
`list_repos`, `select_repo` — works with any valid token. `select_repo` is not
gated: it moves only *this connection's* active repo (see below).

A read-only token also never causes an **index build**. Touching a repo whose
derived graph isn't built normally makes the server run the indexer on first
use, which writes `.reposkein/nodes.jsonl`, `edges.jsonl`, and the committed
summary shards — the one mutation a read-only caller could otherwise trigger
just by naming an unbuilt repo. Read-only connections skip that step entirely
and get an explanation instead:

```
/srv/checkouts/other has no built graph (.reposkein/nodes.jsonl is derived from the
working tree and git-ignored, so a fresh clone has none), and this connection is
read-only — the server will not build one for it. Ask the operator to run
`reposkein-mcp index /srv/checkouts/other`, or use a write-capable token. Nothing
was changed.
```

This matters mainly in a workspace: the served checkout is indexed at startup,
but `select_repo` can reach a sibling repo that isn't.

## Per-connection isolation

Each MCP session gets its own server instance: its own active-repo selection,
its own store cache, its own tool-call log file. One caller's `select_repo` is
invisible to every other caller.

Sessions are also **bound to the token that opened them** — presenting someone
else's `Mcp-Session-Id` returns `403 session_token_mismatch`, so a read-only
credential can never inherit a write-capable session. Unknown session ids get
`404` (re-`initialize` to open a new one), and the process holds at most 64
concurrent sessions.

A session with **no request for 5 minutes is reaped** and its id starts
returning `404`. Clients that crash or lose the network never send the DELETE
that closes their session, so without this a long-lived server slowly fills up
with corpses and eventually refuses new connections at the cap. A session with
a request still executing is never reaped, however long that request takes, and
every new-connection attempt sweeps idle sessions first — so a server wedged at
the cap by dead clients frees itself on the next connect, with no operator
action.

## Staying current with the checkout

The server polls `git rev-parse HEAD` on `--watch-interval` and re-indexes
**only** when HEAD differs from `.reposkein/local/indexed-at` — the same marker
`reposkein-mcp doctor` reads, so the watcher and the staleness check can never
disagree. Consequences of that design:

- An unchanged checkout costs one `git rev-parse` per tick and logs nothing.
- `git pull` in the served checkout produces exactly **one** re-index, one
  log line, and a refreshed `/api/*` handler (so the viewer's counts move with
  the tools').
- A restart doesn't re-index a checkout that is already current, because the
  marker is on disk.
- Re-index failures keep serving the previous graph and retry on the next tick.
- It is a **poll, not a filesystem watcher**: the indexer's determinism
  guarantee is defined against committed state, and an fs watcher would fire on
  every editor save.
- Indexer runs are **serialized process-wide**. A write-capable tool call that
  triggers an index (`reindex_file`, `init_cpg_skeleton`, `record_decision`'s
  pre-stamp refresh) and the HEAD watcher can now arrive from different
  connections at once; two indexers on one checkout would interleave their
  writes to the same files. The watcher **skips** a tick while another run holds
  the lock rather than queueing behind it, so a busy server doesn't accumulate
  redundant full indexes.

Keep the checkout updated however you like — `git fetch && git reset --hard` in
a cron job, a deploy hook, whatever. `serve` only reacts to HEAD.

### Serve a deploy clone, not a working copy

Indexing writes to the working tree: the committed summary shards absorb any
`local/summaries-*.jsonl` sidecars, so a served checkout accumulates diffs over
time. A re-index also picks up whatever is in the tree at that moment,
including someone's half-finished edits.

`serve` therefore runs `git status --porcelain` at startup and prints a
prominent warning naming those two consequences when the tree is dirty. It is a
**warning, never a refusal** — serving a dirty checkout is sometimes exactly
what you want. But the recommended shape is a dedicated clone that only ever
fast-forwards, used by nothing else.

## Security

RepoSkein is not a hardened multi-tenant service, and this mode does not
pretend to be one. What you get, and what is yours to provide:

**Ours**

- Bearer-token auth on **every** route, including `/api/*` and the viewer.
- Timing-safe token comparison over fixed-length digests; the whole token list
  is scanned with no early exit, so response time reveals neither which token
  matched nor how many exist.
- Tokens are never logged, printed, or echoed into a tool result or error. The
  startup banner and the session log show **names** only.
- Read-only default toolset; write access is per-token and explicit.
- `127.0.0.1` default bind; `--host` is your decision.
- Path traversal on `/api/source` is rejected (lexical **and** realpath
  checks), and slices are line-capped.
- `?token=` is accepted only on viewer routes, never on `/mcp`, and is
  immediately traded for an `HttpOnly; SameSite=Strict` cookie.

**Yours**

- **TLS termination.** `serve` speaks plain HTTP. Put nginx/Caddy/a load
  balancer in front of it, or bind loopback and reach it over an SSH tunnel or
  a private network. Sending a bearer token over cleartext HTTP across an
  untrusted network hands it to anyone on the path.
- **Token distribution and rotation.** There is no token database and no
  revocation endpoint: rotating means changing `REPOSKEIN_SERVE_TOKENS` and
  restarting. Treat each token as a long-lived shared secret and scope it by
  giving each caller its own.
- **Network exposure.** `--host 0.0.0.0` on a public interface publishes your
  source to anyone who obtains a token.
- **Access logging.** If your proxy logs full URLs, the one-time `?token=`
  handshake lands in those logs. Prefer the `Authorization` header for
  anything automated.

**What a valid token can reach.** Any token can read the whole graph, every
committed summary and decision, and arbitrary line ranges of any file in the
served checkout (`/api/source`). There is no per-path or per-repo
authorization. A write-capable token can additionally add summaries, record and
re-status decisions, and trigger a re-index. Hand out read-only tokens by
default, and do not serve a checkout containing secrets you would not give the
token holder directly.

**Explicitly out of scope** (see the ADR): user accounts, OAuth/OIDC, per-path
authorization, rate limiting, audit trails beyond the existing session log,
multi-tenancy (one process, one checkout), and any RepoSkein-operated hosting.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `refusing to start with no tokens` | `REPOSKEIN_SERVE_TOKENS` unset/empty and no `[serve] tokens`. Also check stderr for dropped entries (short secret, bad name, unknown capability field). |
| `401 unauthorized` on every route | Missing or wrong `Authorization: Bearer`. The server logs `401 <METHOD> <path>` plus `no bearer token` or `token rejected` — never a secret. |
| `404 session_not_found` | The session was idle for 5 minutes, was closed, or the server restarted. Re-`initialize`. |
| `403 session_token_mismatch` | Two callers sharing one `Mcp-Session-Id`. Give each its own connection. |
| `405 sse_stream_not_supported` | Something opened `GET /mcp`. This server has no notification stream; POST-only is expected and clients continue fine. |
| `503 too_many_sessions` | 64 live sessions. Usually clients that never sent DELETE — idle ones are reaped after 5 minutes and the next connect sweeps them, so this normally clears itself. If it persists, something is opening a session per request instead of reusing one. |
| `write_capability_required` | The token lacks `:write`. |
| `read-only — the server will not build one for it` | A read-only token reached a repo whose graph isn't built. Run `reposkein-mcp index <path>` on the server, or use a write-capable token. |
| `WARNING — the served checkout has N uncommitted change(s)` | Advisory only. See "Serve a deploy clone" above. |
| The viewer 404s but `/api/*` works | The packaged viewer bundle is missing (`mcp/dist/viz`). Reinstall the package, or `npm run build` in `mcp/`. |
| The graph never updates | `--watch-interval 0`, or the served path is not a git checkout (`no-head`), or re-indexing is failing — check stderr. |

## See also

- [`INSTALL.md`](INSTALL.md) — the normal (stdio) setup.
- [`HOSTING.md`](HOSTING.md) — publishing a **static** constellation to GitHub
  Pages. No server, no tokens; the right answer when you only want the viewer.
- [`VIEWER.md`](VIEWER.md) — `reposkein-mcp view`, the local read-only viewer.
- [`TOOLS.md`](TOOLS.md) — the MCP tool reference.
