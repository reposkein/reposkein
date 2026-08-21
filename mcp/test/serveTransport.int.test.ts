import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServeApp, MCP_PATH, type ServeApp } from "../src/serve/serve.js";
import { makeViewHandler } from "../src/cli/view.js";
import { parseServeTokens } from "../src/serve/tokens.js";

/** Integration in the REAL-SOCKET sense: a live HTTP server, the SDK's own
 *  Streamable HTTP client, and the actual `/api/*` handler. Unlike this
 *  package's other `*.int.test.ts` suites it needs NO external infra (no
 *  Neo4j, no indexer binary, loopback only), so it always runs. */

const REPO_ID = "servetest";
const READ_TOKEN = "read-token-0123456789";
const WRITE_TOKEN = "write-token-0123456789";
const TOKENS = parseServeTokens(
  `reader:${READ_TOKEN}, ci-writer:${WRITE_TOKEN}:write`
).tokens;

const NODES = [
  `{"id":"rs1:servetest:file:svc.py","labels":["File"],"content_hash":"hf","name":"svc.py","path":"svc.py"}`,
  `{"id":"rs1:servetest:func:svc.py#Svc.run@1","labels":["Function"],"content_hash":"hr","end_line":4,"file_path":"svc.py","name":"run","qualified_name":"Svc.run","start_line":2}`,
  `{"id":"rs1:servetest:func:base.py#helper@0","labels":["Function"],"content_hash":"hh","end_line":2,"file_path":"base.py","name":"helper","qualified_name":"helper","start_line":1}`,
].join("\n") + "\n";

const EDGES =
  `{"from":"rs1:servetest:func:svc.py#Svc.run@1","type":"CALLS","to":"rs1:servetest:func:base.py#helper@0","call_sites":1,"confidence":1.0,"resolution":"exact"}\n`;

function writeRepo(root: string, repoId: string): void {
  const dir = join(root, ".reposkein");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ repo_id: repoId, schema_version: 1 }));
  writeFileSync(join(dir, "nodes.jsonl"), NODES.replaceAll("servetest", repoId));
  writeFileSync(join(dir, "edges.jsonl"), EDGES.replaceAll("servetest", repoId));
  writeFileSync(join(root, "svc.py"), "class Svc:\n    def run(self):\n        return helper()\n");
}

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((r) => server.close(() => r()));
}

/** Connects an MCP client over Streamable HTTP with a bearer token. */
async function connect(base: string, token: string): Promise<Client> {
  const client = new Client({ name: "serve-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + MCP_PATH), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  return content?.[0]?.text ?? "";
}

describe("serve --http — auth", () => {
  let root: string;
  let app: ServeApp;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "reposkein-serve-auth-"));
    writeRepo(root, REPO_ID);
    app = createServeApp({ repoPath: root, repoId: REPO_ID, tokens: TOKENS, log: () => {} });
    ({ server, base } = await listen(app.handler));
  });
  afterAll(async () => {
    await app.close();
    await close(server);
    rmSync(root, { recursive: true, force: true });
  });

  it("401s an unauthenticated MCP request and names the scheme", async () => {
    const res = await fetch(base + MCP_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("401s a wrong token", async () => {
    const res = await fetch(base + MCP_PATH, {
      method: "POST",
      headers: { Authorization: "Bearer not-the-token-1234567", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("401s /api/* without a token and 200s with one", async () => {
    const anon = await fetch(base + "/api/graph");
    expect(anon.status).toBe(401);

    const authed = await fetch(base + "/api/graph", {
      headers: { Authorization: `Bearer ${READ_TOKEN}` },
    });
    expect(authed.status).toBe(200);
    const manifest = (await authed.json()) as { root: { repoId: string }; counts: { nodes: number } };
    expect(manifest.root.repoId).toBe(REPO_ID);
    expect(manifest.counts.nodes).toBe(3);
  });

  it("accepts a browser's one-time ?token= handshake and hands back a cookie", async () => {
    const res = await fetch(base + "/?token=" + encodeURIComponent(READ_TOKEN), {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("reposkein_token=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Plain HTTP: `Secure` would make the browser discard the cookie outright.
    expect(cookie).not.toContain("Secure");

    // The cookie then authenticates /api/* like a header would.
    const withCookie = await fetch(base + "/api/graph", {
      headers: { Cookie: `reposkein_token=${encodeURIComponent(READ_TOKEN)}` },
    });
    expect(withCookie.status).toBe(200);
  });

  it("does NOT accept ?token= on the MCP endpoint (header only)", async () => {
    const res = await fetch(base + MCP_PATH + "?token=" + encodeURIComponent(WRITE_TOKEN), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("marks the cookie Secure behind an https-terminating proxy", async () => {
    const res = await fetch(base + "/?token=" + encodeURIComponent(READ_TOKEN), {
      redirect: "manual",
      headers: { "X-Forwarded-Proto": "https, http" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("serve --http — read-only vs write tokens", () => {
  let root: string;
  let app: ServeApp;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "reposkein-serve-caps-"));
    writeRepo(root, REPO_ID);
    app = createServeApp({ repoPath: root, repoId: REPO_ID, tokens: TOKENS, log: () => {} });
    ({ server, base } = await listen(app.handler));
  });
  afterAll(async () => {
    await app.close();
    await close(server);
    rmSync(root, { recursive: true, force: true });
  });

  it("serves read tools to a read-only token", async () => {
    const client = await connect(base, READ_TOKEN);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("semantic_find");
      expect(names).toContain("get_context_profile");
      expect(names).toContain("list_decisions");

      const res = await client.callTool({ name: "semantic_find", arguments: { query: "helper" } });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("helper");
    } finally {
      await client.close();
    }
  });

  it("refuses a write tool from a read-only token with a structured error, changing nothing", async () => {
    const client = await connect(base, READ_TOKEN);
    try {
      const listed = await client.listTools();
      const summaryTool = listed.tools.find((t) => t.name === "write_semantic_summary");
      // Listed, but honest about what will happen.
      expect(summaryTool?.description).toContain("read-only");

      const res = await client.callTool({
        name: "write_semantic_summary",
        arguments: { node_id: "rs1:servetest:func:base.py#helper@0", summary: "Nope." },
      });
      expect(res.isError).toBe(true);
      expect(JSON.parse(textOf(res))).toMatchObject({
        error: "write_capability_required",
        tool: "write_semantic_summary",
        required_capability: "write",
        identity: "reader",
      });
      // Nothing was written for this identity.
      expect(existsSync(join(root, ".reposkein", "local", "summaries-reader.jsonl"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("lets a write token write, and attributes the record to the token's name", async () => {
    const client = await connect(base, WRITE_TOKEN);
    try {
      const res = await client.callTool({
        name: "write_semantic_summary",
        arguments: {
          node_id: "rs1:servetest:func:base.py#helper@0",
          summary: "Shared helper used by the service entry point.",
          model: "test-model",
        },
      });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(textOf(res))).toMatchObject({ ok: true });

      // Attribution: the sidecar is per-writer and stamped with the token name,
      // NOT the anonymous "agent" default.
      const sidecar = join(root, ".reposkein", "local", "summaries-ci-writer.jsonl");
      const record = JSON.parse(readFileSync(sidecar, "utf8").trim().split("\n")[0]!);
      expect(record).toMatchObject({
        id: "rs1:servetest:func:base.py#helper@0",
        semantic_summary: "Shared helper used by the service entry point.",
        summary_by: "ci-writer",
        summary_model: "test-model",
      });
    } finally {
      await client.close();
    }
  });

  it("rejects a session id presented by a different token", async () => {
    const client = await connect(base, WRITE_TOKEN);
    try {
      const transport = (client as unknown as { transport: { sessionId?: string } }).transport;
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      const res = await fetch(base + MCP_PATH, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${READ_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": sessionId!,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "session_token_mismatch" });
    } finally {
      await client.close();
    }
  });

  it("405s a standalone GET stream (no server-initiated notifications)", async () => {
    const res = await fetch(base + MCP_PATH, {
      method: "GET",
      headers: { Authorization: `Bearer ${READ_TOKEN}`, Accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
    expect(await res.json()).toMatchObject({ error: "sse_stream_not_supported" });
  });

  it("400s an empty POST body on an established session", async () => {
    const client = await connect(base, WRITE_TOKEN);
    try {
      const sessionId = (client as unknown as { transport: { sessionId?: string } }).transport
        .sessionId;
      const res = await fetch(base + MCP_PATH, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WRITE_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": sessionId!,
        },
        body: "",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; detail: string };
      expect(body.error).toBe("bad_request");
      expect(body.detail).toContain("Empty POST body");
    } finally {
      await client.close();
    }
  });
});

describe("serve --http — per-connection session isolation", () => {
  let root: string;
  let repoA: string;
  let repoB: string;
  let app: ServeApp;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // A workspace: two sibling repos, no repo at the root — the exact shape
    // `select_repo` exists for, and the one where a process-global session
    // would let one caller move another caller's active repo.
    root = mkdtempSync(join(tmpdir(), "reposkein-serve-iso-"));
    repoA = join(root, "alpha");
    repoB = join(root, "beta");
    mkdirSync(repoA);
    mkdirSync(repoB);
    writeRepo(repoA, "alpharepo");
    writeRepo(repoB, "betarepo");
    app = createServeApp({
      repoPath: root,
      repoId: "workspace",
      tokens: TOKENS,
      log: () => {},
      // The root isn't a repo; the viewer surface is not what this suite tests.
      viewHandlerFactory: () => (_req, res) => {
        res.writeHead(404);
        res.end();
      },
    });
    ({ server, base } = await listen(app.handler));
  });
  afterAll(async () => {
    await app.close();
    await close(server);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps two connections' select_repo choices independent", async () => {
    const one = await connect(base, WRITE_TOKEN);
    const two = await connect(base, WRITE_TOKEN);
    try {
      expect(app.sessionCount()).toBe(2);

      const selA = await one.callTool({ name: "select_repo", arguments: { repo: repoA } });
      expect(JSON.parse(textOf(selA))).toMatchObject({ ok: true });
      const selB = await two.callTool({ name: "select_repo", arguments: { repo: repoB } });
      expect(JSON.parse(textOf(selB))).toMatchObject({ ok: true });

      const selectedIn = async (c: Client): Promise<string | undefined> => {
        const listed = await c.callTool({ name: "list_repos", arguments: {} });
        const parsed = JSON.parse(textOf(listed)) as {
          repos: { path: string; selected: boolean }[];
        };
        return parsed.repos.find((r) => r.selected)?.path;
      };

      // Connection one still sees alpha even though two moved to beta.
      expect(await selectedIn(one)).toBe(repoA);
      expect(await selectedIn(two)).toBe(repoB);

      // And the graph each one reads follows its own selection.
      const fromOne = await one.callTool({ name: "semantic_find", arguments: { query: "helper" } });
      expect(textOf(fromOne)).toContain("alpharepo");
      expect(textOf(fromOne)).not.toContain("betarepo");
      const fromTwo = await two.callTool({ name: "semantic_find", arguments: { query: "helper" } });
      expect(textOf(fromTwo)).toContain("betarepo");
    } finally {
      await one.close();
      await two.close();
    }
  });
});

describe("serve --http — session reaping", () => {
  let root: string;
  let app: ServeApp;
  let server: Server;
  let base: string;
  let clock: number;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "reposkein-serve-reap-"));
    writeRepo(root, REPO_ID);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(async () => {
    clock = 1_000_000;
    app = createServeApp({
      repoPath: root,
      repoId: REPO_ID,
      tokens: TOKENS,
      log: () => {},
      maxSessions: 2,
      idleMs: 60_000,
      now: () => clock,
    });
    ({ server, base } = await listen(app.handler));
  });
  afterEach(async () => {
    await app.close();
    await close(server);
  });

  it("reaps a session idle past the threshold; its id then 404s", async () => {
    const client = await connect(base, READ_TOKEN);
    const sessionId = (client as unknown as { transport: { sessionId?: string } }).transport
      .sessionId;
    expect(app.sessionCount()).toBe(1);

    // Not yet idle.
    clock += 59_000;
    expect(app.sweepIdleSessions()).toBe(0);
    expect(app.sessionCount()).toBe(1);

    clock += 2_000;
    expect(app.sweepIdleSessions()).toBe(1);
    expect(app.sessionCount()).toBe(0);

    const res = await fetch(base + MCP_PATH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${READ_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "session_not_found" });
    await client.close().catch(() => undefined);
  });

  it("an active client is never reaped (each request re-stamps it)", async () => {
    const client = await connect(base, READ_TOKEN);
    try {
      clock += 59_000;
      await client.listTools(); // touches the session at the new clock
      clock += 30_000; // past idleMs since CONNECT, but not since that call
      expect(app.sweepIdleSessions()).toBe(0);
      expect(app.sessionCount()).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("frees the cap by reaping, so the next connect after eviction succeeds", async () => {
    const a = await connect(base, READ_TOKEN);
    const b = await connect(base, READ_TOKEN);
    expect(app.sessionCount()).toBe(2); // maxSessions

    // A third while both are live: refused, and the refusal is legible.
    const refused = await fetch(base + MCP_PATH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${READ_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      }),
    });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: "too_many_sessions" });

    // Both go idle. The next initialize sweeps them itself — no operator
    // action, no timer — and is admitted.
    clock += 120_000;
    const third = await connect(base, READ_TOKEN);
    try {
      expect(app.sessionCount()).toBe(1);
      expect((await third.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await third.close();
      await a.close().catch(() => undefined);
      await b.close().catch(() => undefined);
    }
  });
});

describe("serve --http — the reaper never kills an in-flight request", () => {
  let root: string;
  let app: ServeApp;
  let server: Server;
  let base: string;
  let clock = 1_000_000;
  /** Resolved by the test to let the blocked tool call finish. */
  let release: () => void;
  let entered: Promise<void>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "reposkein-serve-inflight-"));
    writeRepo(root, REPO_ID);
    let signalEntered!: () => void;
    entered = new Promise<void>((r) => (signalEntered = r));
    const gate = new Promise<void>((r) => (release = r));
    app = createServeApp({
      repoPath: root,
      repoId: REPO_ID,
      tokens: TOKENS,
      log: () => {},
      idleMs: 60_000,
      now: () => clock,
      // The first repo-scoped tool call on a write-capable connection goes
      // through ensureGraph; blocking there gives a deterministic in-flight
      // request without needing a slow tool.
      ensureGraph: async () => {
        signalEntered();
        await gate;
        return "present";
      },
    });
    ({ server, base } = await listen(app.handler));
  });
  afterAll(async () => {
    await app.close();
    await close(server);
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a session with a request in flight, and that request still completes", async () => {
    const client = await connect(base, WRITE_TOKEN);
    try {
      const pending = client.callTool({
        name: "get_context_profile",
        arguments: { name: "helper" },
      });
      await entered; // the handler is now inside ensureGraph

      // Push the clock far past the idle window while the call is blocked.
      clock += 600_000;
      expect(app.sweepIdleSessions()).toBe(0);
      expect(app.sessionCount()).toBe(1);

      release();
      const res = await pending;
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("helper");
    } finally {
      await client.close();
    }
  });
});

describe("serve --http — a read-only token never triggers an index build", () => {
  let root: string;
  let indexedRepo: string;
  let unbuiltRepo: string;
  let ensureGraphCalls: string[];
  let app: ServeApp;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    // A workspace with one built repo and one that has meta.json but no
    // nodes.jsonl — exactly a fresh clone, and exactly what would have made
    // the old code spawn an indexer on first touch.
    root = mkdtempSync(join(tmpdir(), "reposkein-serve-build-gate-"));
    indexedRepo = join(root, "built");
    unbuiltRepo = join(root, "unbuilt");
    mkdirSync(indexedRepo);
    mkdirSync(unbuiltRepo);
    writeRepo(indexedRepo, "builtrepo");
    mkdirSync(join(unbuiltRepo, ".reposkein"), { recursive: true });
    writeFileSync(
      join(unbuiltRepo, ".reposkein", "meta.json"),
      JSON.stringify({ repo_id: "unbuiltrepo", schema_version: 1 })
    );

    ensureGraphCalls = [];
    app = createServeApp({
      repoPath: root,
      repoId: "workspace",
      tokens: TOKENS,
      log: () => {},
      viewHandlerFactory: () => (_req, res) => {
        res.writeHead(404);
        res.end();
      },
      ensureGraph: async (path) => {
        ensureGraphCalls.push(String(path));
        return "skipped";
      },
    });
    ({ server, base } = await listen(app.handler));
  });
  afterAll(async () => {
    await app.close();
    await close(server);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses with a build-free explanation and never reaches ensureGraph", async () => {
    ensureGraphCalls.length = 0;
    const client = await connect(base, READ_TOKEN);
    try {
      await client.callTool({ name: "select_repo", arguments: { repo: unbuiltRepo } });
      const res = await client.callTool({
        name: "get_context_profile",
        arguments: { name: "helper" },
      });
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain("read-only");
      expect(text).toContain(`reposkein-mcp index ${unbuiltRepo}`);
      expect(text).toContain("Nothing was changed");
      // The point: no build was even attempted.
      expect(ensureGraphCalls).toEqual([]);
      // And nothing appeared on disk.
      expect(existsSync(join(unbuiltRepo, ".reposkein", "nodes.jsonl"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("still serves a read-only token from a repo that IS built, with no build", async () => {
    ensureGraphCalls.length = 0;
    const client = await connect(base, READ_TOKEN);
    try {
      await client.callTool({ name: "select_repo", arguments: { repo: indexedRepo } });
      const res = await client.callTool({ name: "semantic_find", arguments: { query: "helper" } });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("builtrepo");
      expect(ensureGraphCalls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("a write-capable token DOES get the build attempt for the same repo", async () => {
    ensureGraphCalls.length = 0;
    const client = await connect(base, WRITE_TOKEN);
    try {
      await client.callTool({ name: "select_repo", arguments: { repo: unbuiltRepo } });
      await client.callTool({ name: "get_context_profile", arguments: { name: "helper" } });
      expect(ensureGraphCalls).toEqual([unbuiltRepo]);
    } finally {
      await client.close();
    }
  });
});

describe("serve --http — /api/* parity with `view`", () => {  let root: string;
  let app: ServeApp;
  let serveServer: Server;
  let viewServer: Server;
  let serveBase: string;
  let viewBase: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "reposkein-serve-parity-"));
    writeRepo(root, REPO_ID);
    app = createServeApp({ repoPath: root, repoId: REPO_ID, tokens: TOKENS, log: () => {} });
    ({ server: serveServer, base: serveBase } = await listen(app.handler));
    // The other side of the comparison is literally what `reposkein-mcp view`
    // serves: makeViewHandler, unwrapped.
    ({ server: viewServer, base: viewBase } = await listen(makeViewHandler(root, REPO_ID)));
  });
  afterAll(async () => {
    await app.close();
    await close(serveServer);
    await close(viewServer);
    rmSync(root, { recursive: true, force: true });
  });

  const authed = (path: string): Promise<Response> =>
    fetch(serveBase + path, { headers: { Authorization: `Bearer ${READ_TOKEN}` } });

  it("returns the same /api/graph manifest (modulo the per-handler build time)", async () => {
    const a = (await (await authed("/api/graph")).json()) as Record<string, unknown>;
    const b = (await (await fetch(viewBase + "/api/graph")).json()) as Record<string, unknown>;
    delete (a.meta as Record<string, unknown>).builtAt;
    delete (b.meta as Record<string, unknown>).builtAt;
    expect(a).toEqual(b);
  });

  it("returns the same /api/jsonl/nodes.jsonl bytes", async () => {
    const a = await (await authed("/api/jsonl/nodes.jsonl")).text();
    const b = await (await fetch(viewBase + "/api/jsonl/nodes.jsonl")).text();
    expect(a).toBe(b);
    expect(a).toContain("rs1:servetest:func:base.py#helper@0");
  });

  it("returns the same /api/source slice, and keeps its traversal guard", async () => {
    const q = "?path=svc.py&start=1&end=3";
    const a = await (await authed("/api/source" + q)).json();
    const b = await (await fetch(viewBase + "/api/source" + q)).json();
    expect(a).toEqual(b);

    const escape = await authed("/api/source?path=../../etc/passwd&start=1&end=1");
    expect(escape.status).toBe(404);
  });

  it("returns the same /api/temporal payload", async () => {
    const a = await (await authed("/api/temporal")).text();
    const b = await (await fetch(viewBase + "/api/temporal")).text();
    expect(a).toBe(b);
  });
});
