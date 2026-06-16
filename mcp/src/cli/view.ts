import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  readFileSync,
  existsSync,
  statSync,
  createReadStream,
  mkdirSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, normalize, extname } from "node:path";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { packageRoot } from "../indexer/fetchBinary.js";
import { getTemporal } from "../temporal/temporal.js";

/** The prebuilt viz/ SPA bundle, copied into the mcp package at build time
 *  (scripts/bundle-viz.mjs copies viz/dist -> mcp/dist/viz). */
export function vizDistDir(): string {
  return join(packageRoot(), "dist", "viz");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface ViewOptions {
  port: number;
  host: string;
  open: boolean;
}

/** Resolves a request path safely under `root`, rejecting traversal. Returns
 *  the absolute path or null if it escapes `root`. */
function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const abs = resolve(root, "." + (rel.startsWith("/") ? rel : "/" + rel));
  const rootAbs = resolve(root);
  if (abs === rootAbs || abs.startsWith(rootAbs + "/")) return abs;
  return null;
}

function buildManifest(repoId: string, repoRoot: string): string {
  return JSON.stringify({
    root: {
      repoId,
      // Absolute-from-origin (leading slash): these are fetched inside a Web
      // Worker whose base URL is the worker script's location (/assets/...),
      // not the document root — relative paths would resolve to /assets/api/...
      // and hit the SPA catch-all (HTML), breaking JSON parsing.
      nodesUrl: "/api/jsonl/nodes.jsonl",
      edgesUrl: "/api/jsonl/edges.jsonl",
      // Absolute path of the served repo root, so the viewer can build a
      // vscode://file/<abs>:<line> "open in editor" link. Read-only metadata;
      // the loopback-only server already trusts its caller (design §8).
      repoRoot,
    },
    federated: [], // M1: single repo. Federation deferred to M3.
    counts: { nodes: 0, edges: 0 }, // counts are advisory; the client re-derives.
  });
}

/** Max lines a single /api/source request may return (cap, design §P3). */
const SOURCE_MAX_LINES = 400;

function sendGzip(res: ServerResponse, body: string, contentType: string): void {
  const gz = gzipSync(Buffer.from(body, "utf8"));
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Encoding": "gzip",
    "Cache-Control": "no-store",
  });
  res.end(gz);
}

function send404(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

/** Opens a URL in the default browser cross-platform. Best-effort. */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* ignore — the URL is printed regardless */
  }
}

/** Builds the request handler. Exposed for tests (no listening socket). */
export function makeViewHandler(repoPath: string, repoId: string) {
  const reposkeinDir = join(repoPath, ".reposkein");
  const nodesPath = join(reposkeinDir, "nodes.jsonl");
  const edgesPath = join(reposkeinDir, "edges.jsonl");
  const distDir = vizDistDir();

  const repoRoot = resolve(repoPath);

  return function handler(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? "/";
    const qIdx = rawUrl.indexOf("?");
    const url = (qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx)) || "/";

    // --- API routes ---
    if (url === "/api/graph") {
      sendGzip(res, buildManifest(repoId, repoRoot), "application/json; charset=utf-8");
      return;
    }

    // Read-only source slice (design §P3). Path-guarded by safeJoin (rejects
    // traversal → 404); range clamped + capped at SOURCE_MAX_LINES. Returns
    // JSON { path, start, end, lines: string[] }. NEVER 5xx: a missing file,
    // bad params, or a directory all yield 404 so the panel degrades to "no
    // source" instead of breaking.
    if (url === "/api/source") {
      try {
        const params = new URLSearchParams(qIdx === -1 ? "" : rawUrl.slice(qIdx + 1));
        const relPath = params.get("path");
        if (!relPath) return send404(res);
        const abs = safeJoin(repoRoot, relPath); // traversal → null → 404
        if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return send404(res);
        const total = readFileSync(abs, "utf8").split("\n");
        // A trailing newline yields a phantom empty final element; drop it so
        // line counts match the file's actual line count.
        if (total.length > 0 && total[total.length - 1] === "") total.pop();
        // Lines are 1-based in the graph records; clamp to the file bounds.
        const startReq = parseInt(params.get("start") ?? "1", 10);
        const endReq = parseInt(params.get("end") ?? "0", 10);
        const start = Math.max(1, Number.isFinite(startReq) ? startReq : 1);
        let end = Number.isFinite(endReq) && endReq >= start ? endReq : start;
        end = Math.min(end, total.length, start + SOURCE_MAX_LINES - 1);
        const lines = total.slice(start - 1, end);
        sendGzip(
          res,
          JSON.stringify({ path: relPath, start, end, lines }),
          "application/json; charset=utf-8",
        );
      } catch {
        // Defensive: any unexpected read error degrades to 404 (never 5xx).
        send404(res);
      }
      return;
    }
    if (url === "/api/jsonl/nodes.jsonl" || url === "/api/jsonl/edges.jsonl") {
      const file = url.endsWith("nodes.jsonl") ? nodesPath : edgesPath;
      if (!existsSync(file)) return send404(res);
      try {
        sendGzip(res, readFileSync(file, "utf8"), "application/x-ndjson; charset=utf-8");
      } catch {
        send404(res);
      }
      return;
    }

    // Temporal-coupling overlay (best-effort). Returns the git-derived
    // file co-change map, or {} when git/temporal is unavailable. NEVER 5xx —
    // the overlay is additive and must never break the structural render.
    if (url === "/api/temporal") {
      getTemporal(repoPath)
        .then((result) => {
          // getTemporal never throws; on unavailable we still answer 200 {}.
          const cochange = "cochange" in result ? result.cochange : {};
          sendGzip(res, JSON.stringify(cochange), "application/json; charset=utf-8");
        })
        .catch(() => {
          // Defensive: should be unreachable (getTemporal is fail-safe).
          sendGzip(res, "{}", "application/json; charset=utf-8");
        });
      return;
    }

    // --- Static SPA bundle ---
    let rel = url === "/" ? "/index.html" : url;
    let abs = safeJoin(distDir, rel);
    // SPA fallback: unknown non-asset paths serve index.html.
    if (!abs || !existsSync(abs) || statSync(abs).isDirectory()) {
      rel = "/index.html";
      abs = safeJoin(distDir, rel);
    }
    if (!abs || !existsSync(abs)) return send404(res);

    const type = MIME[extname(abs)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    createReadStream(abs).pipe(res);
  };
}

/** `reposkein-mcp view [repoPath] [--port N] [--host H] [--no-open]`.
 *  Serves the prebuilt viz bundle + the repo's committed JSONL on 127.0.0.1.
 *  Read-only; no external services. Returns the process exit code. */
export async function runView(repoPath: string, repoId: string, opts: ViewOptions): Promise<number> {
  const nodesPath = join(repoPath, ".reposkein", "nodes.jsonl");
  if (!existsSync(nodesPath)) {
    console.error(
      `reposkein: no .reposkein/nodes.jsonl at ${repoPath}.\n` +
        "  Build the graph first: `reposkein-mcp index` (or `reposkein-mcp init`)."
    );
    return 1;
  }
  const distDir = vizDistDir();
  if (!existsSync(join(distDir, "index.html"))) {
    console.error(
      `reposkein: the viewer bundle is missing (${distDir}).\n` +
        "  Rebuild the package: `npm run build` in mcp/ (which copies viz/dist)."
    );
    return 1;
  }

  const handler = makeViewHandler(repoPath, repoId);
  const server = createServer(handler);

  return await new Promise<number>((resolvePromise) => {
    server.on("error", (err) => {
      console.error(`reposkein: view server error: ${err.message}`);
      resolvePromise(1);
    });
    // Bind 127.0.0.1 only (loopback; no auth needed — design §8).
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      const link = `http://${opts.host}:${port}/`;
      console.error(`reposkein: viewer serving ${repoId} at ${link} (Ctrl-C to stop)`);
      if (opts.open) openBrowser(link);
      // Resolve is deferred until the process is killed; keep the server alive.
    });

    const shutdown = () => {
      server.close(() => resolvePromise(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

/** Parses `view` CLI args (after the `view` subcommand). When `--export <dir>`
 *  is present, returns `exportDir` set (and the server opts are ignored). */
export function parseViewArgs(argv: string[]): {
  repoPath: string;
  opts: ViewOptions;
  exportDir: string | null;
} {
  let port = 4317;
  let host = "127.0.0.1";
  let open = true;
  let exportDir: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-open") open = false;
    else if (a === "--port") port = parseInt(argv[++i] ?? "4317", 10) || 4317;
    else if (a.startsWith("--port=")) port = parseInt(a.slice(7), 10) || 4317;
    else if (a === "--host") host = argv[++i] ?? "127.0.0.1";
    else if (a.startsWith("--host=")) host = a.slice(7);
    else if (a === "--export") exportDir = argv[++i] ?? null;
    else if (a.startsWith("--export=")) exportDir = a.slice(9);
    else if (!a.startsWith("-")) positional.push(a);
  }
  const repoPath = positional[0] ?? process.env.REPOSKEIN_REPO_PATH ?? ".";
  return { repoPath, opts: { port, host, open }, exportDir };
}

/** Builds the contents of `graph-data.js` for a static export: a single
 *  assignment of `window.__REPOSKEIN_GRAPH__` with the manifest + the inlined
 *  JSONL text. The viewer's static-mode path parses this on the main thread.
 *
 *  Pure (string in → string out) so the baked shape is unit-testable. The
 *  payload is a JSON.stringify'd object assigned in an external .js file (NOT
 *  inline HTML), so `</script>` sequences in the JSONL need no escaping. */
export function buildGraphDataJs(
  repoId: string,
  nodesText: string,
  edgesText: string,
): string {
  // Static export bakes a single repo (no federation) and intentionally OMITS
  // repoRoot — the export is shared/hosted, so a local absolute path is both
  // meaningless and a leak; server-only features degrade in the viewer.
  const payload = {
    manifest: {
      root: {
        repoId,
        // These URLs are unused in static mode (the worker is skipped); kept
        // for shape parity with the live manifest.
        nodesUrl: "/api/jsonl/nodes.jsonl",
        edgesUrl: "/api/jsonl/edges.jsonl",
      },
      federated: [],
      counts: { nodes: 0, edges: 0 },
    },
    nodesText,
    edgesText,
  };
  return `window.__REPOSKEIN_GRAPH__ = ${JSON.stringify(payload)};\n`;
}

/** Injects `<script src="./graph-data.js"></script>` into `html` BEFORE the
 *  first app bundle `<script ... src=...>` (or before </head> / </body> as a
 *  fallback) so the global is set prior to the app booting. Pure. Idempotent:
 *  returns `html` unchanged if the inject is already present. */
export function injectGraphDataScript(html: string): string {
  const tag = `<script src="./graph-data.js"></script>`;
  if (html.includes("graph-data.js")) return html;
  // Vite emits a module script for the app bundle; inject before the first one.
  const m = html.match(/<script\b[^>]*\bsrc=/i);
  if (m && m.index !== undefined) {
    return html.slice(0, m.index) + tag + "\n    " + html.slice(m.index);
  }
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `  ${tag}\n  </head>`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `  ${tag}\n  </body>`);
  return html + tag;
}

/** `reposkein-mcp view --export <outDir> [repoPath]`.
 *  Writes a SELF-CONTAINED static site to `<outDir>`: the viz bundle plus the
 *  repo's graph baked into `graph-data.js`, so it loads with NO server (works
 *  from file:// and from any static-host subpath). Returns the exit code. */
export async function runExport(
  repoPath: string,
  repoId: string,
  outDir: string,
): Promise<number> {
  const reposkeinDir = join(repoPath, ".reposkein");
  const nodesPath = join(reposkeinDir, "nodes.jsonl");
  const edgesPath = join(reposkeinDir, "edges.jsonl");
  if (!existsSync(nodesPath)) {
    console.error(
      `reposkein: no .reposkein/nodes.jsonl at ${repoPath}.\n` +
        "  Build the graph first: `reposkein-mcp index` (or `reposkein-mcp init`).",
    );
    return 1;
  }
  const distDir = vizDistDir();
  if (!existsSync(join(distDir, "index.html"))) {
    console.error(
      `reposkein: the viewer bundle is missing (${distDir}).\n` +
        "  Rebuild the package: `npm run build` in mcp/ (which copies viz/dist).",
    );
    return 1;
  }

  const absOut = resolve(outDir);
  try {
    // 1) Copy the prebuilt viz bundle into the output directory.
    mkdirSync(absOut, { recursive: true });
    cpSync(distDir, absOut, { recursive: true });

    // 2) Bake the repo graph into graph-data.js.
    const nodesText = readFileSync(nodesPath, "utf8");
    const edgesText = existsSync(edgesPath) ? readFileSync(edgesPath, "utf8") : "";
    writeFileSync(
      join(absOut, "graph-data.js"),
      buildGraphDataJs(repoId, nodesText, edgesText),
      "utf8",
    );

    // 3) Inject the graph-data.js script into index.html before the app bundle.
    const indexPath = join(absOut, "index.html");
    const html = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, injectGraphDataScript(html), "utf8");
  } catch (err) {
    console.error(
      `reposkein: export failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  console.error(`reposkein: exported static constellation for ${repoId} -> ${absOut}`);
  console.error(`  open ${join(absOut, "index.html")} or host this folder.`);
  return 0;
}
