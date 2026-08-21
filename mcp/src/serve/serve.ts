import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { makeViewHandler, vizDistDir } from "../cli/view.js";
import { createMcpServer, type CreateMcpServerOptions } from "../server/createMcpServer.js";
import { agentSlug } from "../store/sidecar.js";
import { resolveSessionId } from "../store/sessionLog.js";
import {
  bearerFromAuthHeader,
  loadServeTokens,
  matchServeToken,
  type ServeToken,
} from "./tokens.js";
import { startHeadWatcher, type HeadWatcher } from "./watch.js";

/** The one path the MCP Streamable HTTP transport answers on. Everything else
 *  is the viewer + `/api/*`, served by view.ts's own handler. */
export const MCP_PATH = "/mcp";

/** Cookie the viewer gets after a successful `?token=` handshake, so a browser
 *  can keep loading `/api/*` without the secret in every URL. */
const TOKEN_COOKIE = "reposkein_token";

/** Cap on a single JSON-RPC POST body. Tool arguments are prose and node ids;
 *  4 MB is orders of magnitude past anything legitimate. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Cap on concurrent MCP sessions. A leaked token shouldn't be able to make
 *  the process allocate servers without bound; an operator hitting this has a
 *  problem worth an error, not silent growth. */
const MAX_SESSIONS = 64;

/** How long a session may sit untouched before it is reaped.
 *
 *  A crashed or network-partitioned client never sends the DELETE that closes
 *  its session, so without this every such client permanently consumes one of
 *  MAX_SESSIONS — and a long-lived server eventually wedges at the cap with
 *  nothing but corpses. Five minutes is far longer than any tool call and far
 *  shorter than a working day, so a live-but-idle agent that comes back gets a
 *  clean `404 session_not_found` and re-initializes. */
const SESSION_IDLE_MS = 5 * 60 * 1000;

export interface ServeOptions {
  port: number;
  host: string;
  /** `git rev-parse HEAD` poll interval. 0 disables the watcher. */
  watchIntervalMs: number;
}

/** Default bind host. NOT 0.0.0.0: even in the mode that exists to be
 *  reachable, exposure is an explicit `--host` decision by the operator. */
export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 4318;
export const DEFAULT_WATCH_INTERVAL_MS = 30_000;

export function parseServeArgs(argv: string[]): {
  repoPath: string;
  opts: ServeOptions;
  http: boolean;
} {
  let port = DEFAULT_SERVE_PORT;
  let host = DEFAULT_SERVE_HOST;
  let watchIntervalMs = DEFAULT_WATCH_INTERVAL_MS;
  let http = false;
  const positional: string[] = [];
  const intArg = (raw: string | undefined, fallback: number): number => {
    const n = parseInt(raw ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--http") http = true;
    else if (a === "--port") port = intArg(argv[++i], DEFAULT_SERVE_PORT);
    else if (a.startsWith("--port=")) port = intArg(a.slice(7), DEFAULT_SERVE_PORT);
    else if (a === "--host") host = argv[++i] ?? DEFAULT_SERVE_HOST;
    else if (a.startsWith("--host=")) host = a.slice(7);
    // Seconds on the CLI (an operator thinks in seconds), ms internally.
    else if (a === "--watch-interval") watchIntervalMs = intArg(argv[++i], 30) * 1000;
    else if (a.startsWith("--watch-interval="))
      watchIntervalMs = intArg(a.slice(17), 30) * 1000;
    else if (!a.startsWith("-")) positional.push(a);
  }
  const repoPath = positional[0] ?? process.env.REPOSKEIN_REPO_PATH ?? ".";
  return { repoPath, opts: { port, host, watchIntervalMs }, http };
}

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** The token NAME that created this session. A session is bound to it: a
   *  different token presenting a stolen session id gets 403, so a read-only
   *  credential can never inherit a write-capable session. */
  tokenName: string;
  /** `now()` at the START of the most recent request on this session.
   *  Stamped at start, not completion, so a request that outlives the idle
   *  window is protected by `inFlight` rather than by a moving timestamp —
   *  the two guards stay independent and each one is testable alone. */
  lastSeen: number;
  /** Requests currently executing on this session. A session is NEVER reaped
   *  while this is above zero: killing a session mid-tool-call would drop the
   *  response on the floor and leave the caller waiting forever. */
  inFlight: number;
}

export interface CreateServeAppOptions {
  repoPath: string;
  repoId: string;
  tokens: readonly ServeToken[];
  log?: (message: string) => void;
  /** Test seam: replaces `makeViewHandler` (which reads the repo's JSONL and
   *  shells out to git at construction time). */
  viewHandlerFactory?: (repoPath: string, repoId: string) => NodeHandler;
  /** Test seam: passed through to every per-connection `createMcpServer`. */
  ensureGraph?: CreateMcpServerOptions["ensureGraph"];
  /** Concurrent-session cap. Defaults to `MAX_SESSIONS` (64); lowered in
   *  tests so the cap and the reaper-then-retry path are cheap to exercise. */
  maxSessions?: number;
  /** Idle-session reap threshold. Defaults to `SESSION_IDLE_MS` (5 min). */
  idleMs?: number;
  /** Clock. Injectable so the reaper can be tested without waiting minutes. */
  now?: () => number;
}

export interface ServeApp {
  handler: NodeHandler;
  /** Rebuilds the `/api/*` handler. The view handler snapshots node/edge
   *  counts and git metadata once per construction, so after a re-index the
   *  hosted viewer would otherwise keep reporting the old graph — this is the
   *  watcher's `onReindexed` hook, and it is why the MCP tools and the viewer
   *  cannot drift apart: they are refreshed by the same event. */
  refresh: () => void;
  /** Closes every session idle past `idleMs` with no request in flight, and
   *  returns how many it closed. Called automatically before each new-session
   *  attempt (so a server wedged at the cap by dead clients frees itself on
   *  the next connect); exposed for tests. */
  sweepIdleSessions: () => number;
  close: () => Promise<void>;
  sessionCount: () => number;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

interface BodyOk {
  ok: true;
  /** `undefined` for an empty body — the caller decides whether that's legal. */
  value: unknown;
}
interface BodyErr {
  ok: false;
  error: string;
  /** True when the cap tripped: the caller must answer BEFORE destroying the
   *  request, or the client gets a socket reset instead of the 400. */
  oversize?: boolean;
}

/** Reads a request body as JSON, capped. Resolves `{ ok: false }` on a bad
 *  parse or an oversized body — never throws, never buffers past the cap.
 *
 *  Deliberately does NOT destroy the request itself: on oversize it stops
 *  accumulating and resolves, leaving the caller to write its 400 first and
 *  destroy afterwards. Destroying here raced the response and turned a clean
 *  "body too large" into an unexplained connection reset. */
function readJsonBody(req: IncomingMessage): Promise<BodyOk | BodyErr> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: BodyOk | BodyErr): void => {
      if (settled) return;
      settled = true;
      resolvePromise(r);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return; // over cap already; drain without buffering
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        finish({
          ok: false,
          error: `request body exceeds ${MAX_BODY_BYTES} bytes`,
          oversize: true,
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return finish({ ok: true, value: undefined });
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        finish({ ok: false, error: "request body is not valid JSON" });
      }
    });
    req.on("error", () => finish({ ok: false, error: "request stream error" }));
  });
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Builds the one request handler that answers both the MCP endpoint and the
 *  viewer/`/api/*` surface (REP-17 requirement: one process, one graph).
 *
 *  URL layout:
 *    POST/GET/DELETE `/mcp`  — MCP Streamable HTTP transport
 *    GET `/api/graph`, `/api/jsonl/*`, `/api/source`, `/api/temporal`
 *                            — byte-identical to `reposkein-mcp view`, because
 *                              it IS view.ts's handler, not a copy
 *    GET everything else     — the prebuilt viewer SPA
 *
 *  Auth applies to every route. `/mcp` accepts ONLY
 *  `Authorization: Bearer <token>`; the viewer routes additionally accept
 *  `?token=` (which is immediately traded for an HttpOnly cookie and
 *  redirected away, so it appears once) because a static SPA in a browser
 *  cannot attach an Authorization header to its own page load. */
export function createServeApp(opts: CreateServeAppOptions): ServeApp {
  const log = opts.log ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const factory = opts.viewHandlerFactory ?? makeViewHandler;
  const repoPath = resolve(opts.repoPath);
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const idleMs = opts.idleMs ?? SESSION_IDLE_MS;
  const now = opts.now ?? Date.now;
  // One session-log id per PROCESS (honoring REPOSKEIN_SESSION_ID), suffixed
  // per token below. Computed once here rather than per connection: a
  // reconnecting agent should append to the same file it was writing before,
  // and `reposkein-mcp stats` groups by that id.
  const logIdBase = resolveSessionId(process.env);
  let viewHandler = factory(repoPath, opts.repoId);
  const sessions = new Map<string, McpSession>();
  // Slots claimed by an in-progress `initialize` that has not yet registered
  // its session. The cap check and this increment are one synchronous pair,
  // which is what closes the check-then-set race: without it, N concurrent
  // initializes all saw `sessions.size` from before any of them had connected
  // and every one of them was admitted.
  let reservedSlots = 0;

  /** Closes idle, quiescent sessions. See `ServeApp.sweepIdleSessions`. */
  function sweepIdleSessions(): number {
    const cutoff = now() - idleMs;
    let closed = 0;
    for (const [id, s] of [...sessions]) {
      if (s.inFlight > 0) continue; // never kill a live request
      if (s.lastSeen > cutoff) continue;
      sessions.delete(id);
      closed++;
      log(`reposkein serve: reaped idle mcp session for "${s.tokenName}"`);
      void s.transport.close().catch(() => undefined);
      void s.server.close().catch(() => undefined);
    }
    return closed;
  }

  const unauthorized = (res: ServerResponse, detail: string): void =>
    sendJson(
      res,
      401,
      { error: "unauthorized", detail },
      { "WWW-Authenticate": `Bearer realm="reposkein"` }
    );

  /** Authenticates one request. `allowCookieAndQuery` is false for `/mcp`. */
  function authenticate(
    req: IncomingMessage,
    url: URL,
    allowCookieAndQuery: boolean
  ): { token: ServeToken | null; fromQuery: boolean } {
    const header = bearerFromAuthHeader(req.headers.authorization);
    const hit = matchServeToken(opts.tokens, header);
    if (hit || !allowCookieAndQuery) return { token: hit, fromQuery: false };
    const fromQuery = url.searchParams.get("token");
    const q = matchServeToken(opts.tokens, fromQuery);
    if (q) return { token: q, fromQuery: true };
    const cookie = cookieValue(req.headers.cookie, TOKEN_COOKIE);
    return { token: matchServeToken(opts.tokens, cookie), fromQuery: false };
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, token: ServeToken): Promise<void> {
    // No standalone notification stream. This server never sends anything the
    // client didn't ask for (every tool is request/response, `enableJsonResponse`
    // is on), so a GET would open a socket that stays open for the connection's
    // whole life and produces nothing. Worse, it never completes — which meant
    // it pinned `inFlight` above zero and made the idle reaper a no-op for any
    // client that opened one. The spec allows 405 here; clients treat the
    // stream as optional and carry on.
    if (req.method === "GET") {
      sendJson(
        res,
        405,
        {
          error: "sse_stream_not_supported",
          detail:
            "This server answers MCP over POST only (JSON responses, no server-initiated " +
            "notifications). Use POST for requests and DELETE to end a session.",
        },
        { Allow: "POST, DELETE" }
      );
      return;
    }

    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        sendJson(res, 404, {
          error: "session_not_found",
          detail:
            "This Mcp-Session-Id is unknown (expired after 5 minutes idle, closed, or the " +
            "server restarted). Re-run initialize to open a new session.",
        });
        return;
      }
      if (existing.tokenName !== token.name) {
        sendJson(res, 403, {
          error: "session_token_mismatch",
          detail:
            "This MCP session belongs to a different token. Start a new session " +
            "(omit Mcp-Session-Id) instead of reusing another caller's.",
        });
        return;
      }
      // Claim the session for the duration of this request: `lastSeen` keeps
      // the reaper away from an active client, `inFlight` keeps it away from
      // an active REQUEST even if that request outlives the idle window.
      existing.lastSeen = now();
      existing.inFlight++;
      try {
        const body =
          req.method === "POST" ? await readJsonBody(req) : { ok: true as const, value: undefined };
        if (!body.ok) {
          sendJson(res, 400, { error: "bad_request", detail: body.error });
          if (body.oversize) req.destroy();
          return;
        }
        if (req.method === "POST" && body.value === undefined) {
          sendJson(res, 400, {
            error: "bad_request",
            detail: "Empty POST body. Send a JSON-RPC request, notification, or batch.",
          });
          return;
        }
        await existing.transport.handleRequest(req, res, body.value);
      } finally {
        existing.inFlight--;
      }
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 400, {
        error: "bad_request",
        detail: "Mcp-Session-Id is required for DELETE on /mcp.",
      });
      return;
    }

    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, 400, { error: "bad_request", detail: body.error });
      if (body.oversize) req.destroy();
      return;
    }
    if (!isInitializeRequest(body.value)) {
      sendJson(res, 400, {
        error: "bad_request",
        detail:
          "No valid Mcp-Session-Id and this is not an initialize request. " +
          "Open a session with initialize first.",
      });
      return;
    }
    // Free anything the network already abandoned before deciding we're full.
    sweepIdleSessions();
    if (sessions.size + reservedSlots >= maxSessions) {
      sendJson(res, 503, {
        error: "too_many_sessions",
        detail: `This server holds the maximum of ${maxSessions} MCP sessions. Retry later.`,
      });
      return;
    }
    // Reserved synchronously, in the same tick as the check above.
    reservedSlots++;
    // Set by `onsessioninitialized` the moment the session is registered with
    // `inFlight: 1` (this request). Held out here, not read back off the
    // transport, so the `finally` can release the count on EVERY exit path.
    // If anything after registration throws — the SDK `await`s our callback
    // and does not guard it, and the response write can fail — an inline
    // decrement is skipped, and a session stuck at `inFlight: 1` is one the
    // reaper will never touch: a slot leaked until restart.
    let registeredId: string | undefined;

    try {
      // A NEW connection: its own McpServer, its own RepoSession. Nothing in
      // here is shared with any other session, which is what makes one
      // caller's `select_repo` invisible to everybody else.
      const server = createMcpServer({
        cwd: repoPath,
        envRepoPath: repoPath,
        // One log file per token per process, so an operator can see who did
        // what without every connection sharing one file.
        sessionId: `${logIdBase}-${agentSlug(token.name)}`,
        identity: token.name,
        capabilities: { write: token.write },
        ...(opts.ensureGraph ? { ensureGraph: opts.ensureGraph } : {}),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // Plain JSON responses rather than an SSE stream per request: this
        // server has no server-initiated notifications to push, and a
        // request/response shape keeps sockets short-lived (and shutdown
        // instant) on a long-running shared process.
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
          registeredId = id;
          sessions.set(id, {
            transport,
            server,
            tokenName: token.name,
            lastSeen: now(),
            // The initialize request itself is in flight right now.
            inFlight: 1,
          });
          log(`reposkein serve: mcp session opened for "${token.name}" (write=${token.write})`);
        },
        onsessionclosed: (id: string) => {
          sessions.delete(id);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
        void server.close().catch(() => {
          /* shutting down */
        });
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body.value);
    } finally {
      // Mirrors the existing-session branch: this request's own `inFlight`
      // claim is released HERE, not inline after `handleRequest`, so no exit
      // path can skip it.
      //
      // Defense in depth as of SDK 1.30: the Node wrapper runs the transport
      // inside `@hono/node-server`'s request listener, which catches handler
      // errors and answers 500 itself — so a throw after registration does not
      // currently reject `handleRequest`. That is a library implementation
      // detail we don't control, and it is the only thing that was keeping an
      // inline decrement correct. Structurally, nothing may sit between the
      // request completing and the claim being released.
      if (registeredId !== undefined) {
        const created = sessions.get(registeredId);
        if (created) created.inFlight--;
      }
      reservedSlots--;
    }
  }

  const handler: NodeHandler = (req, res) => {
    const rawUrl = req.url ?? "/";
    // The base is a placeholder — only pathname/searchParams are used.
    const url = new URL(rawUrl, "http://localhost");
    const isMcp = url.pathname === MCP_PATH;

    const { token, fromQuery } = authenticate(req, url, !isMcp);
    if (!token) {
      log(
        `reposkein serve: 401 ${req.method ?? "?"} ${url.pathname} ` +
          `(${req.headers.authorization ? "token rejected" : "no bearer token"})`
      );
      unauthorized(
        res,
        isMcp
          ? "Send `Authorization: Bearer <token>`. Ask the operator for a token; see docs/REMOTE.md."
          : "Send `Authorization: Bearer <token>`, or open this page as `?token=<token>` once."
      );
      return;
    }

    if (isMcp) {
      handleMcp(req, res, token).catch((err: unknown) => {
        log(`reposkein serve: mcp request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal_error", detail: "See the server log." });
        } else {
          res.end();
        }
      });
      return;
    }

    // A browser authenticated by `?token=`: trade it for an HttpOnly cookie
    // and redirect to the clean URL, so the secret shows up in exactly one
    // request line instead of every one.
    if (fromQuery) {
      url.searchParams.delete("token");
      const q = url.searchParams.toString();
      // `Secure` whenever the request reached us over TLS. We terminate plain
      // HTTP ourselves, so the only evidence is the proxy's forwarded scheme —
      // set it when that says https so the cookie can't leak back over a
      // downgraded connection, and omit it otherwise (a `Secure` cookie on a
      // genuinely plain-HTTP deployment is simply discarded by the browser,
      // which would break the handshake this exists to provide).
      const forwardedProto = req.headers["x-forwarded-proto"];
      const rawProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
      const proto = (rawProto ?? "").split(",")[0]!.trim().toLowerCase();
      const secure = proto === "https" ? "; Secure" : "";
      res.writeHead(302, {
        Location: url.pathname + (q ? `?${q}` : ""),
        "Set-Cookie":
          `${TOKEN_COOKIE}=${encodeURIComponent(token.token)}; Path=/; HttpOnly; SameSite=Strict${secure}`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    viewHandler(req, res);
  };

  return {
    handler,
    refresh: () => {
      viewHandler = factory(repoPath, opts.repoId);
    },
    sweepIdleSessions,
    close: async () => {
      const open = [...sessions.values()];
      sessions.clear();
      for (const s of open) {
        try {
          await s.transport.close();
        } catch {
          /* best-effort */
        }
        try {
          await s.server.close();
        } catch {
          /* best-effort */
        }
      }
    },
    sessionCount: () => sessions.size,
  };
}

/** `git status --porcelain` for the served checkout, or null when git is
 *  unavailable / the path isn't a repo. Never throws. */
export function gitPorcelainStatus(repoPath: string): string[] | null {
  try {
    const out = execFileSync("git", ["-C", repoPath, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return null;
  }
}

/** The startup warning for serving a checkout with local modifications, or
 *  null when the tree is clean (or git can't tell us).
 *
 *  Serving a dirty checkout is legal and sometimes exactly what an operator
 *  wants, so this WARNS and never refuses. But it is worth saying loudly:
 *  `serve`'s own re-index writes into `.reposkein/` (the committed summary
 *  shards absorb every `local/summaries-*.jsonl` sidecar), so a checkout that
 *  someone also works in will accumulate diffs that look like the server's
 *  fault — and a re-index landing on top of half-finished local edits indexes
 *  those edits. A dedicated deploy clone has neither problem. */
export function dirtyCheckoutWarning(
  repoPath: string,
  statusFn: (p: string) => string[] | null = gitPorcelainStatus
): string | null {
  const lines = statusFn(repoPath);
  if (!lines || lines.length === 0) return null;
  const sample = lines.slice(0, 5).map((l) => `    ${l}`);
  const more = lines.length > sample.length ? `\n    … and ${lines.length - sample.length} more` : "";
  return (
    `reposkein serve: WARNING — the served checkout has ${lines.length} uncommitted ` +
    `change(s):\n${sample.join("\n")}${more}\n` +
    "  Serving it anyway. Two things to know:\n" +
    "    - re-indexing writes into .reposkein/ (committed summary shards absorb the local\n" +
    "      sidecars), so this working tree will keep accumulating diffs.\n" +
    "    - a re-index picks up whatever is in the tree, including half-finished edits.\n" +
    "  Recommended: serve a DEDICATED DEPLOY CLONE that only ever fast-forwards, not a\n" +
    "  working copy someone edits. See docs/REMOTE.md."
  );
}

/** `reposkein-mcp serve --http [path] [--port N] [--host H] [--watch-interval S]`.
 *
 *  Strictly optional (REP-17 / adr:2026-08-21-optional-shared-remote-mcp-server-…):
 *  stdio is still the default transport and nothing binds a socket unless this
 *  runs. Refuses to start without at least one configured token — an
 *  unauthenticated remote MCP server would hand write access to the network. */
export async function runServe(repoPath: string, repoId: string, opts: ServeOptions): Promise<number> {
  const nodesPath = join(repoPath, ".reposkein", "nodes.jsonl");
  if (!existsSync(nodesPath)) {
    console.error(
      `reposkein: no .reposkein/nodes.jsonl at ${repoPath}.\n` +
        "  Build the graph first: `reposkein-mcp index` (or `reposkein-mcp init`)."
    );
    return 1;
  }

  const loaded = loadServeTokens(repoPath, process.env);
  for (const e of loaded.errors) console.error(`reposkein serve: ${e}`);
  if (loaded.tokens.length === 0) {
    console.error(
      "reposkein serve: refusing to start with no tokens.\n" +
        "  Set REPOSKEIN_SERVE_TOKENS='name:secret[:write]' (comma-separated), or add\n" +
        "  [serve] tokens = \"name:secret\" to .reposkein/config.toml (private deployments only —\n" +
        "  config.toml is committed). See docs/REMOTE.md."
    );
    return 1;
  }

  const vizMissing = !existsSync(join(vizDistDir(), "index.html"));
  if (vizMissing) {
    console.error(
      `reposkein serve: the viewer bundle is missing (${vizDistDir()}); /api/* still works, ` +
        "but the SPA will 404. Rebuild the package (`npm run build` in mcp/) to serve it."
    );
  }

  // Warn, never refuse: see `dirtyCheckoutWarning`.
  const dirty = dirtyCheckoutWarning(repoPath);
  if (dirty) console.error(dirty);

  const app = createServeApp({ repoPath, repoId, tokens: loaded.tokens });
  const watcher: HeadWatcher = startHeadWatcher(repoPath, repoId, {
    intervalMs: opts.watchIntervalMs,
    onReindexed: () => app.refresh(),
  });
  // Catch up once at startup: the checkout may have moved while nothing was
  // watching it. Same idempotent check as every tick, so an up-to-date repo
  // does no work.
  await watcher.tick();

  const server = createServer(app.handler);

  return await new Promise<number>((resolvePromise) => {
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolvePromise(code);
    };
    server.on("error", (err) => {
      console.error(`reposkein serve: server error: ${err.message}`);
      watcher.stop();
      settle(1);
    });
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const names = loaded.tokens
        .map((t) => `${t.name}${t.write ? " (write)" : ""}`)
        .join(", ");
      console.error(
        `reposkein serve: ${repoId} on http://${opts.host}:${port}\n` +
          `  MCP endpoint:   http://${opts.host}:${port}${MCP_PATH}\n` +
          `  viewer + /api/: http://${opts.host}:${port}/\n` +
          `  tokens (${loaded.source}): ${names}\n` +
          `  watch: ${opts.watchIntervalMs > 0 ? `${opts.watchIntervalMs / 1000}s HEAD poll` : "disabled"}\n` +
          "  plain HTTP — terminate TLS in front of this. Ctrl-C to stop."
      );
    });

    const shutdown = (): void => {
      watcher.stop();
      void app.close().finally(() => {
        server.close(() => settle(0));
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
