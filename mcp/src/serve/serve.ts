import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { makeViewHandler, vizDistDir } from "../cli/view.js";
import { createMcpServer } from "../server/createMcpServer.js";
import { agentSlug } from "../store/sidecar.js";
import { defaultSessionId } from "../store/sessionLog.js";
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
}

export interface CreateServeAppOptions {
  repoPath: string;
  repoId: string;
  tokens: readonly ServeToken[];
  log?: (message: string) => void;
  /** Test seam: replaces `makeViewHandler` (which reads the repo's JSONL and
   *  shells out to git at construction time). */
  viewHandlerFactory?: (repoPath: string, repoId: string) => NodeHandler;
}

export interface ServeApp {
  handler: NodeHandler;
  /** Rebuilds the `/api/*` handler. The view handler snapshots node/edge
   *  counts and git metadata once per construction, so after a re-index the
   *  hosted viewer would otherwise keep reporting the old graph — this is the
   *  watcher's `onReindexed` hook, and it is why the MCP tools and the viewer
   *  cannot drift apart: they are refreshed by the same event. */
  refresh: () => void;
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

/** Reads a request body as JSON, capped. Resolves `{ ok: false }` on a bad
 *  parse or an oversized body — never throws, never buffers past the cap. */
function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: { ok: true; value: unknown } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
        req.destroy();
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
  let viewHandler = factory(repoPath, opts.repoId);
  const sessions = new Map<string, McpSession>();

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
    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        sendJson(res, 404, {
          error: "session_not_found",
          detail:
            "This Mcp-Session-Id is unknown (expired, or the server restarted). " +
            "Re-run initialize to open a new session.",
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
      const body =
        req.method === "POST" ? await readJsonBody(req) : { ok: true as const, value: undefined };
      if (!body.ok) {
        sendJson(res, 400, { error: "bad_request", detail: body.error });
        return;
      }
      await existing.transport.handleRequest(req, res, body.value);
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 400, {
        error: "bad_request",
        detail: "Mcp-Session-Id is required for GET and DELETE on /mcp.",
      });
      return;
    }

    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, 400, { error: "bad_request", detail: body.error });
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
    if (sessions.size >= MAX_SESSIONS) {
      sendJson(res, 503, {
        error: "too_many_sessions",
        detail: `This server holds the maximum of ${MAX_SESSIONS} MCP sessions. Retry later.`,
      });
      return;
    }

    // A NEW connection: its own McpServer, its own RepoSession. Nothing in
    // here is shared with any other session, which is what makes one
    // caller's `select_repo` invisible to everybody else.
    const server = createMcpServer({
      cwd: repoPath,
      envRepoPath: repoPath,
      // One log file per token per process start, so an operator can see who
      // did what without every connection sharing one file.
      sessionId: `${defaultSessionId()}-${agentSlug(token.name)}`,
      identity: token.name,
      capabilities: { write: token.write },
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Plain JSON responses rather than an SSE stream per request: this
      // server has no server-initiated notifications to push, and a
      // request/response shape keeps sockets short-lived (and shutdown
      // instant) on a long-running shared process.
      enableJsonResponse: true,
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport, server, tokenName: token.name });
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
      res.writeHead(302, {
        Location: url.pathname + (q ? `?${q}` : ""),
        "Set-Cookie": `${TOKEN_COOKIE}=${encodeURIComponent(token.token)}; Path=/; HttpOnly; SameSite=Strict`,
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
