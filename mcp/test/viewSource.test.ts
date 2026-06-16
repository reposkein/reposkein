import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { makeViewHandler } from "../src/cli/view.js";

/** Minimal response capture for the sync handler. */
interface CapturedResponse {
  status: number;
  headers: Record<string, string | number | undefined>;
  body: string;
}

function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  url: string,
): Promise<CapturedResponse> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let status = 200;
    let headers: Record<string, string | number | undefined> = {};
    const finish = () => {
      let buf = Buffer.concat(chunks);
      if (headers["Content-Encoding"] === "gzip" && buf.length > 0) {
        buf = gunzipSync(buf);
      }
      resolvePromise({ status, headers, body: buf.toString("utf8") });
    };
    const res = {
      writeHead(code: number, h?: Record<string, string | number>) {
        status = code;
        if (h) headers = { ...headers, ...h };
        return this;
      },
      end(chunk?: Buffer | string) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        finish();
      },
    } as unknown as ServerResponse;
    handler({ url } as IncomingMessage, res);
  });
}

describe("view server /api/source (read-only, path-guarded)", () => {
  let repoDir: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), "rs-view-source-"));
    mkdirSync(join(repoDir, ".reposkein"), { recursive: true });
    mkdirSync(join(repoDir, "src"), { recursive: true });
    // A 10-line source file.
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(repoDir, "src", "foo.ts"), lines + "\n");
    // A secret OUTSIDE the served root (one level up) to prove traversal is blocked.
    writeFileSync(join(repoDir, "..", "rs-view-secret.txt"), "TOPSECRET");
    handler = makeViewHandler(repoDir, "testrepo");
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(join(repoDir, "..", "rs-view-secret.txt"), { force: true });
  });

  it("returns the requested 1-based inclusive line range as JSON", async () => {
    const r = await invoke(handler, "/api/source?path=src/foo.ts&start=2&end=4");
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body) as { start: number; end: number; lines: string[] };
    expect(json.start).toBe(2);
    expect(json.end).toBe(4);
    expect(json.lines).toEqual(["line 2", "line 3", "line 4"]);
  });

  it("clamps the end to the file length", async () => {
    const r = await invoke(handler, "/api/source?path=src/foo.ts&start=8&end=999");
    const json = JSON.parse(r.body) as { end: number; lines: string[] };
    expect(json.end).toBe(10);
    expect(json.lines.length).toBe(3); // lines 8,9,10
  });

  it("caps the slice at 400 lines", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `L${i}`).join("\n");
    writeFileSync(join(repoDir, "src", "big.ts"), big + "\n");
    const r = await invoke(handler, "/api/source?path=src/big.ts&start=1&end=1000");
    const json = JSON.parse(r.body) as { end: number; lines: string[] };
    expect(json.lines.length).toBe(400);
    expect(json.end).toBe(400);
  });

  it("404s on a missing file (never 5xx)", async () => {
    const r = await invoke(handler, "/api/source?path=src/nope.ts&start=1&end=5");
    expect(r.status).toBe(404);
  });

  it("404s on a missing path param", async () => {
    const r = await invoke(handler, "/api/source");
    expect(r.status).toBe(404);
  });

  it("rejects path traversal (does NOT leak files above the repo root)", async () => {
    for (const evil of [
      "/api/source?path=../rs-view-secret.txt&start=1&end=1",
      "/api/source?path=..%2F..%2Frs-view-secret.txt&start=1&end=1",
      "/api/source?path=%2Fetc%2Fpasswd&start=1&end=1",
    ]) {
      const r = await invoke(handler, evil);
      expect(r.body).not.toContain("TOPSECRET");
      // Either 404 (traversal blocked) or, for the absolute-path case, the
      // safeJoin re-roots it under repoDir where the file does not exist → 404.
      expect(r.status).toBe(404);
    }
  });

  it("404s when the path resolves to a directory", async () => {
    const r = await invoke(handler, "/api/source?path=src&start=1&end=5");
    expect(r.status).toBe(404);
  });

  it("exposes the repo root in the manifest for editor links", async () => {
    const r = await invoke(handler, "/api/graph");
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body) as { root: { repoRoot?: string } };
    expect(json.root.repoRoot).toBeTruthy();
  });
});
