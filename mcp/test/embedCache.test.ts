/**
 * Tests for the derived embedding cache.
 * All tests are offline (no real API). Uses MockProvider from embedProvider.test.ts.
 * Uses a temp directory (via os.tmpdir) so no .reposkein/ pollution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDocString,
  sha256,
  cachePath,
  loadCache,
  saveCache,
  embedCorpus,
} from "../src/embed/cache.js";
import { MockProvider } from "./embedProvider.test.js";
import type { CorpusNode } from "../src/store/GraphStore.js";

// Helper to build minimal CorpusNode
function cn(
  id: string,
  qn: string,
  signature = "",
  summary = "",
  file_path = "src/a.ts"
): CorpusNode {
  return {
    id,
    kind: "Function",
    name: qn.split(".").pop() ?? qn,
    qualified_name: qn,
    signature,
    summary,
    file_path,
    repo_id: "testrepo",
  };
}

const NODE_A = cn("id:1", "auth.validateToken", "(token: string): boolean", "Validates a JWT", "src/auth.ts");
const NODE_B = cn("id:2", "billing.charge", "(amount: number): void", "Charges a card", "src/billing.ts");
const NODE_C = cn("id:3", "util.toString", "", "", "src/util.ts");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "reposkein-embed-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ——— buildDocString ———

describe("buildDocString", () => {
  it("includes qualified_name, signature, summary, file_path", () => {
    const doc = buildDocString(NODE_A);
    expect(doc).toContain("auth.validateToken");
    expect(doc).toContain("(token: string): boolean");
    expect(doc).toContain("Validates a JWT");
    expect(doc).toContain("src/auth.ts");
  });

  it("omits empty signature and summary", () => {
    const doc = buildDocString(NODE_C);
    expect(doc).toBe("util.toString\nsrc/util.ts");
  });

  it("is deterministic across calls", () => {
    expect(buildDocString(NODE_A)).toBe(buildDocString(NODE_A));
  });
});

// ——— sha256 ———

describe("sha256", () => {
  it("returns a 64-char hex string", () => {
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
  });

  it("produces different hashes for different inputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

// ——— cachePath ———

describe("cachePath", () => {
  it("encodes provider id, model id, and dims in the filename", () => {
    const p = new MockProvider({ id: "voyage", modelId: "voyage-code-3", dims: 1024 });
    const path = cachePath("/repo", p);
    expect(path).toContain("voyage__voyage-code-3__d1024");
    expect(path).toMatch(/\.jsonl$/);
  });

  it("different providers → different paths", () => {
    const p1 = new MockProvider({ id: "voyage", modelId: "voyage-code-3", dims: 1024 });
    const p2 = new MockProvider({ id: "http", modelId: "voyage-4-nano", dims: 512 });
    expect(cachePath("/repo", p1)).not.toBe(cachePath("/repo", p2));
  });
});

// ——— loadCache / saveCache ———

describe("loadCache/saveCache", () => {
  it("returns empty map for non-existent path", () => {
    const path = join(tmpDir, "nonexistent.jsonl");
    expect(loadCache(path).size).toBe(0);
  });

  it("round-trips records", () => {
    const path = join(tmpDir, "test.jsonl");
    const records = new Map([
      ["id:1", { id: "id:1", doc_hash: "abc123", v: [0.1, 0.2, 0.3] }],
      ["id:2", { id: "id:2", doc_hash: "def456", v: [0.4, 0.5, 0.6] }],
    ]);
    saveCache(path, records);
    const loaded = loadCache(path);
    expect(loaded.size).toBe(2);
    expect(loaded.get("id:1")).toEqual({ id: "id:1", doc_hash: "abc123", v: [0.1, 0.2, 0.3] });
    expect(loaded.get("id:2")).toEqual({ id: "id:2", doc_hash: "def456", v: [0.4, 0.5, 0.6] });
  });

  it("skips malformed lines gracefully", () => {
    const path = join(tmpDir, "test.jsonl");
    const { writeFileSync } = require("node:fs");
    writeFileSync(path, '{"id":"id:1","doc_hash":"h1","v":[1]}\nnot-json\n{"id":"id:2","doc_hash":"h2","v":[2]}\n');
    const loaded = loadCache(path);
    expect(loaded.size).toBe(2);
  });

  it("saves sorted by id", () => {
    const path = join(tmpDir, "sorted.jsonl");
    const records = new Map([
      ["id:3", { id: "id:3", doc_hash: "c", v: [3] }],
      ["id:1", { id: "id:1", doc_hash: "a", v: [1] }],
      ["id:2", { id: "id:2", doc_hash: "b", v: [2] }],
    ]);
    saveCache(path, records);
    const { readFileSync } = require("node:fs");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const ids = lines.map((l: string) => JSON.parse(l).id);
    expect(ids).toEqual(["id:1", "id:2", "id:3"]);
  });
});

// ——— embedCorpus ———

describe("embedCorpus", () => {
  it("cold build: embeds all corpus nodes", async () => {
    const provider = new MockProvider({ dims: 4 });
    const corpus = [NODE_A, NODE_B, NODE_C];
    const result = await embedCorpus(provider, tmpDir, corpus);
    expect(result.size).toBe(3);
    expect(provider.embedCallCount).toBe(1); // one batch call
    expect(provider.lastTexts.length).toBe(3);
    expect(provider.lastKind).toBe("document");
  });

  it("warm run with unchanged corpus: embeds ZERO nodes (cache hit)", async () => {
    const provider = new MockProvider({ dims: 4 });
    const corpus = [NODE_A, NODE_B];
    // First pass (cold)
    await embedCorpus(provider, tmpDir, corpus);
    expect(provider.embedCallCount).toBe(1);

    // Second pass (warm)
    await embedCorpus(provider, tmpDir, corpus);
    expect(provider.embedCallCount).toBe(1); // no new calls
  });

  it("doc_hash change: re-embeds only the changed node", async () => {
    const provider = new MockProvider({ dims: 4 });

    // First pass
    const corpus1 = [NODE_A, NODE_B];
    await embedCorpus(provider, tmpDir, corpus1);
    expect(provider.embedCallCount).toBe(1);

    // Mutate NODE_A's summary (different doc_hash)
    const NODE_A_UPDATED = cn("id:1", "auth.validateToken", "(token: string): boolean", "UPDATED summary", "src/auth.ts");
    const corpus2 = [NODE_A_UPDATED, NODE_B];
    const result2 = await embedCorpus(provider, tmpDir, corpus2);

    // Should have called embed again (for NODE_A_UPDATED only)
    expect(provider.embedCallCount).toBe(2);
    expect(provider.lastTexts.length).toBe(1); // only re-embedded one node
    expect(provider.lastTexts[0]).toContain("UPDATED summary");
    expect(result2.size).toBe(2);
  });

  it("switching provider: uses a different cache file", async () => {
    const provider1 = new MockProvider({ id: "voyage", modelId: "voyage-code-3", dims: 1024 });
    const provider2 = new MockProvider({ id: "http", modelId: "voyage-4-nano", dims: 512 });
    const corpus = [NODE_A];

    await embedCorpus(provider1, tmpDir, corpus);
    await embedCorpus(provider2, tmpDir, corpus);

    // Both should have embedded (different cache files)
    expect(provider1.embedCallCount).toBe(1);
    expect(provider2.embedCallCount).toBe(1);

    // Different cache files exist
    const path1 = cachePath(tmpDir, provider1);
    const path2 = cachePath(tmpDir, provider2);
    expect(path1).not.toBe(path2);
    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(true);
  });

  it("returns vectors for all corpus nodes", async () => {
    const provider = new MockProvider({ dims: 4 });
    const corpus = [NODE_A, NODE_B, NODE_C];
    const result = await embedCorpus(provider, tmpDir, corpus);
    for (const node of corpus) {
      const v = result.get(node.id);
      expect(v).toBeDefined();
      expect(v!.length).toBe(4);
    }
  });

  it("throws on provider error (callers must catch + fallback)", async () => {
    const provider = new MockProvider({ dims: 4 });
    provider.throwError = new Error("network failure");
    await expect(embedCorpus(provider, tmpDir, [NODE_A])).rejects.toThrow("network failure");
  });
});
