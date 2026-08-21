import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  readFileSync,
  existsSync,
  statSync,
  createReadStream,
  mkdirSync,
  cpSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve, normalize, extname } from "node:path";
import { gzipSync } from "node:zlib";
import { spawn, execFileSync } from "node:child_process";
import { packageRoot } from "../indexer/fetchBinary.js";
import { readTeamPagesUrl } from "../store/teamConfig.js";
import { getTemporal } from "../temporal/temporal.js";
import { discoverFederatedRepos } from "./federatedDiscovery.js";
import { collectSourceSlices, type SourceSliceEntry } from "./sourceSlices.js";

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
 *  the absolute path or null if it escapes `root`.
 *
 *  Two layers of defense:
 *   1. Lexical: normalize + strip leading `../` and re-root the request under
 *      `root`, then prefix-check — blocks `../` style traversal.
 *   2. realpath: resolve symlinks on BOTH the target and the root, then
 *      re-check containment under the REAL root. A symlink *inside* the served
 *      root that points outside passes the lexical check but is caught here.
 *      ENOENT (a not-yet-existing path, e.g. a missing file the caller will
 *      404 on anyway) is fine — return the lexical path so the caller's own
 *      existsSync handles it; never crash on a missing path. */
function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const abs = resolve(root, "." + (rel.startsWith("/") ? rel : "/" + rel));
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + "/")) return null;

  // realpath defense: a symlink inside `root` could point outside it. Resolve
  // the real root once; if the target doesn't resolve (ENOENT), the lexical
  // check already passed — hand it back and let the caller 404 on absence.
  let realRoot: string;
  try {
    realRoot = realpathSync(rootAbs);
  } catch {
    // The served root itself is missing — nothing can be safely served.
    return null;
  }
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch {
    // Target (or a parent) doesn't exist yet: no symlink to escape through.
    // Keep the lexical path; existence is enforced by the caller.
    return abs;
  }
  if (realAbs === realRoot || realAbs.startsWith(realRoot + "/")) return abs;
  return null;
}

export interface RepoBakeMeta {
  commitSha: string | null;
  builtAt: string | null;
  repoUrl: string | null;
  /** `[team] pages_url` from `.reposkein/config.toml`, or null when unset.
   *  The team's canonical/CI-published constellation link (e.g. a GitHub
   *  Pages URL) — distinct from whatever local `view`/export a machine
   *  happens to be looking at. Drives the viewer header's "team constellation"
   *  link (viz/src/routes/Root.tsx). */
  pagesUrl: string | null;
}

/** Best-effort git introspection for the live `view` server: the current HEAD
 *  sha + a guessed web URL for `origin` (github.com only; other hosts degrade
 *  to null rather than guessing wrong), plus `[team] pages_url` from
 *  config.toml. Never throws — any failure (not a repo, no origin, git
 *  missing, no config.toml) yields nulls so the affected UI just doesn't
 *  render. Computed ONCE at server start (not per-request) since it shells
 *  out to git. */
export function resolveServerRepoMeta(repoPath: string): RepoBakeMeta {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  };
  const commitSha = git(["rev-parse", "HEAD"]);
  const remote = git(["remote", "get-url", "origin"]);
  const repoUrl = remote ? githubHttpsUrl(remote) : null;
  const pagesUrl = readTeamPagesUrl(repoPath);
  return { commitSha, builtAt: new Date().toISOString(), repoUrl, pagesUrl };
}

/** Normalizes a git remote URL (https or ssh form) to an https://github.com/...
 *  web URL. Returns null for non-github.com remotes (no safe guess). */
function githubHttpsUrl(remote: string): string | null {
  const httpsMatch = remote.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
  const sshMatch = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  return null;
}

/** Counts records in a `.jsonl` file's text: one non-blank line, one record.
 *  Tolerates a trailing newline (the common case) and any stray blank lines
 *  without over- or under-counting. Shared by the live manifest and the
 *  static-export bake (REP-22 polish: both used to hardcode `{ nodes: 0,
 *  edges: 0 }` with a "the client re-derives" comment — true for the live
 *  worker path, but the baked `graph-data.js` payload is also a document
 *  other tooling may read directly, so a real count belongs in it too). */
function countJsonlRecords(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split("\n")) if (line.trim().length > 0) count++;
  return count;
}

function buildManifest(
  repoId: string,
  repoRoot: string,
  meta: RepoBakeMeta,
  counts: { nodes: number; edges: number },
): string {
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
    counts,
    meta,
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
  // Computed once (shells out to git / reads the JSONL files) — cheap and
  // stable for the server's lifetime; recomputing per-request would add a
  // git spawn and two file reads to every /api/graph hit.
  const repoMeta = resolveServerRepoMeta(repoPath);
  const counts = {
    nodes: existsSync(nodesPath) ? countJsonlRecords(readFileSync(nodesPath, "utf8")) : 0,
    edges: existsSync(edgesPath) ? countJsonlRecords(readFileSync(edgesPath, "utf8")) : 0,
  };

  return function handler(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? "/";
    const qIdx = rawUrl.indexOf("?");
    const url = (qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx)) || "/";

    // --- API routes ---
    if (url === "/api/graph") {
      sendGzip(res, buildManifest(repoId, repoRoot, repoMeta, counts), "application/json; charset=utf-8");
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
/** Metadata baked into a static export, driving the viewer's staleness badge.
 *  `builtAt` defaults to bake-time (now) when not given explicitly — it is the
 *  one time-derived field: the same repo + commitSha + builtAt always bakes
 *  byte-identical output, but builtAt itself is naturally different per run
 *  unless the caller pins it (e.g. for a reproducibility test). */
export interface ExportBakeOptions {
  commitSha?: string | null;
  repoUrl?: string | null;
  builtAt?: string | null;
  /** `[team] pages_url`; defaults to reading `.reposkein/config.toml` at
   *  export time when omitted (same source resolveServerRepoMeta uses in
   *  server mode) — pass explicitly only to override or pin it. */
  pagesUrl?: string | null;
  /** Bake size-capped per-node source slices (design: optional, flag-gated). */
  withSource?: boolean;
  /** Byte cap for baked source slices; only consulted when withSource is true. */
  sourceMaxBytes?: number;
  /** How many directory levels to scan for nested `.reposkein/` repos. */
  federatedDepth?: number;
}

export function parseViewArgs(argv: string[]): {
  repoPath: string;
  opts: ViewOptions;
  exportDir: string | null;
  exportOpts: ExportBakeOptions;
} {
  let port = 4317;
  let host = "127.0.0.1";
  let open = true;
  let exportDir: string | null = null;
  let commitSha: string | null = null;
  let repoUrl: string | null = null;
  let builtAt: string | null = null;
  let pagesUrl: string | undefined;
  let withSource = false;
  let sourceMaxBytes: number | undefined;
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
    else if (a === "--commit-sha") commitSha = argv[++i] ?? null;
    else if (a.startsWith("--commit-sha=")) commitSha = a.slice(13);
    else if (a === "--repo-url") repoUrl = argv[++i] ?? null;
    else if (a.startsWith("--repo-url=")) repoUrl = a.slice(11);
    else if (a === "--built-at") builtAt = argv[++i] ?? null;
    else if (a.startsWith("--built-at=")) builtAt = a.slice(11);
    else if (a === "--pages-url") pagesUrl = argv[++i];
    else if (a.startsWith("--pages-url=")) pagesUrl = a.slice(12);
    else if (a === "--with-source") {
      withSource = true;
      // Optional numeric byte-cap as the next bare token (e.g. `--with-source 500000`).
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) sourceMaxBytes = parseInt(argv[++i]!, 10);
    } else if (a.startsWith("--with-source=")) {
      withSource = true;
      const v = a.slice(14);
      if (/^\d+$/.test(v)) sourceMaxBytes = parseInt(v, 10);
    } else if (!a.startsWith("-")) positional.push(a);
  }
  const repoPath = positional[0] ?? process.env.REPOSKEIN_REPO_PATH ?? ".";
  const exportOpts: ExportBakeOptions = {
    commitSha: commitSha ?? process.env.REPOSKEIN_COMMIT_SHA ?? null,
    repoUrl: repoUrl ?? process.env.REPOSKEIN_REPO_URL ?? null,
    builtAt,
    pagesUrl: pagesUrl ?? process.env.REPOSKEIN_PAGES_URL, // undefined -> runExport reads config.toml itself
    withSource,
    sourceMaxBytes,
  };
  return { repoPath, opts: { port, host, open }, exportDir, exportOpts };
}

/** A federated repo's data inlined into a static export (self-contained: no
 *  fetch of nodesUrl/edgesUrl at runtime — the viewer reads federatedText). */
export interface FederatedBakeEntry {
  repoId: string;
  rootPath: string;
  nodesText: string;
  edgesText: string;
}

/** Extra data baked into `graph-data.js` alongside the root repo's JSONL. */
export interface GraphDataExtra {
  meta?: RepoBakeMeta;
  /** Git-derived file co-change map (same shape /api/temporal returns), or
   *  omitted/{} when temporal data is unavailable. */
  cochange?: Record<string, { path: string; support: number; confidence: number }[]>;
  federated?: FederatedBakeEntry[];
  /** node id -> source slice, size-capped (design: optional, flag-gated). */
  sourceSlices?: Record<string, SourceSliceEntry>;
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
  extra: GraphDataExtra = {},
): string {
  const federated = extra.federated ?? [];
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
      // federated[] entries carry no fetchable URLs in a static export — the
      // actual text is inlined below (federatedText), read entirely offline.
      federated: federated.map((f) => ({
        repoId: f.repoId,
        rootPath: f.rootPath,
        nodesUrl: "",
        edgesUrl: "",
      })),
      counts: { nodes: countJsonlRecords(nodesText), edges: countJsonlRecords(edgesText) },
    },
    nodesText,
    edgesText,
    federatedText: federated.map((f) => ({
      repoId: f.repoId,
      nodesText: f.nodesText,
      edgesText: f.edgesText,
    })),
    meta: extra.meta ?? { commitSha: null, builtAt: null, repoUrl: null, pagesUrl: null },
    cochange: extra.cochange ?? {},
    ...(extra.sourceSlices ? { sourceSlices: extra.sourceSlices } : {}),
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
 *  from file:// and from any static-host subpath). Returns the exit code.
 *
 *  Determinism: given the same repo state + the same {commitSha, repoUrl,
 *  builtAt} inputs, the export is byte-identical. `builtAt` is the one
 *  time-derived field (defaults to bake-time `new Date().toISOString()` when
 *  not passed) — pin it explicitly for a reproducible export. */
export async function runExport(
  repoPath: string,
  repoId: string,
  outDir: string,
  bake: ExportBakeOptions = {},
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

    // 2) Bake the repo graph + metadata + temporal + federation into graph-data.js.
    const nodesText = readFileSync(nodesPath, "utf8");
    const edgesText = existsSync(edgesPath) ? readFileSync(edgesPath, "utf8") : "";

    const meta: RepoBakeMeta = {
      commitSha: bake.commitSha ?? null,
      repoUrl: bake.repoUrl ?? null,
      builtAt: bake.builtAt ?? new Date().toISOString(),
      pagesUrl: bake.pagesUrl !== undefined ? bake.pagesUrl : readTeamPagesUrl(repoPath),
    };

    // Temporal co-change data: the SAME code path /api/temporal uses, called
    // once at export time so the static viewer's coupling overlay works
    // offline. Best-effort — degrades to {} on any failure (never blocks the
    // export).
    const temporalResult = await getTemporal(repoPath);
    const cochange = "cochange" in temporalResult ? temporalResult.cochange : {};

    // Federation: nested `.reposkein/` repos discovered under repoPath, inlined
    // in full (self-contained — no network fetch of federated JSONL at runtime).
    const federatedRepos = discoverFederatedRepos(repoPath, bake.federatedDepth ?? 6);
    const federated: FederatedBakeEntry[] = [];
    for (const fed of federatedRepos) {
      const fNodes = join(fed.absPath, ".reposkein", "nodes.jsonl");
      const fEdges = join(fed.absPath, ".reposkein", "edges.jsonl");
      if (!existsSync(fNodes)) continue; // not indexed — skip, don't fail the export
      federated.push({
        repoId: fed.repoId,
        rootPath: fed.rootPath,
        nodesText: readFileSync(fNodes, "utf8"),
        edgesText: existsSync(fEdges) ? readFileSync(fEdges, "utf8") : "",
      });
    }

    const sourceSlices = bake.withSource
      ? collectSourceSlices(repoPath, nodesText, bake.sourceMaxBytes ?? DEFAULT_SOURCE_MAX_BYTES)
      : undefined;

    writeFileSync(
      join(absOut, "graph-data.js"),
      buildGraphDataJs(repoId, nodesText, edgesText, { meta, cochange, federated, sourceSlices }),
      "utf8",
    );

    // 3) Inject the graph-data.js script into index.html before the app bundle.
    const indexPath = join(absOut, "index.html");
    const html = readFileSync(indexPath, "utf8");
    const injected = injectGraphDataScript(html);
    writeFileSync(indexPath, injected, "utf8");

    // 4) SPA fallback for static hosts (esp. GitHub Pages): serve the app for
    // ANY unknown path. Pages returns 404.html for paths with no matching file,
    // so a copy of index.html makes deep links / client routes / refreshes load
    // the viewer instead of the host's "Not Found" page.
    writeFileSync(join(absOut, "404.html"), injected, "utf8");
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

/** Default byte cap for baked per-node source slices (--with-source). */
const DEFAULT_SOURCE_MAX_BYTES = 2_000_000;
