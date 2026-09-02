/**
 * Tests for embedCorpus's incremental persistence.
 *
 * Observed through the cache file, not internals: an interrupted cold run must
 * leave the batches it already completed on disk, so a re-run embeds only what
 * is still missing. Before this, the cache was written once after the whole
 * corpus succeeded, so an OOM-kill discarded every vector computed and the next
 * query reissued the identical request — a loop that never made progress.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedCorpus, cachePath, loadCache } from "../src/embed/cache.js";
import type { EmbeddingProvider, EmbedKind, BatchLimits } from "../src/embed/provider.js";
import type { CorpusNode } from "../src/store/GraphStore.js";

const DIMS = 4;

/** Fails on the Nth request, after succeeding on the ones before it. */
class FlakyProvider implements EmbeddingProvider {
  public requests: string[][] = [];
  constructor(
    private readonly failOnRequest: number | null,
    private readonly maxItems = 2,
  ) {}
  id(): string { return "flaky"; }
  modelId(): string { return "flaky-v1"; }
  dims(): number { return DIMS; }
  limits(): BatchLimits { return { maxItems: this.maxItems, maxTokens: 1_000_000 }; }
  async embedBatch(texts: string[], _kind: EmbedKind): Promise<number[][]> {
    this.requests.push([...texts]);
    if (this.failOnRequest !== null && this.requests.length === this.failOnRequest) {
      throw new Error("simulated OOM-kill mid-corpus");
    }
    return texts.map((t) => vecFor(t));
  }
}

/** Deterministic vector so a re-run can be compared against the first run. */
function vecFor(text: string): number[] {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) & 0xffffffff;
  const v: number[] = [];
  for (let d = 0; d < DIMS; d++) {
    h = ((h << 5) + h + d) & 0xffffffff;
    v.push(((h >>> 0) % 10001) / 10000);
  }
  return v;
}

function cn(id: string, qn: string): CorpusNode {
  return {
    id,
    kind: "Function",
    name: qn.split(".").pop() ?? qn,
    qualified_name: qn,
    signature: "()",
    summary: "",
    file_path: "src/a.ts",
    repo_id: "testrepo",
  };
}

const CORPUS = [
  cn("id:1", "a.one"),
  cn("id:2", "a.two"),
  cn("id:3", "a.three"),
  cn("id:4", "a.four"),
  cn("id:5", "a.five"),
];

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "reposkein-embed-resume-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe("embedCorpus — incremental persistence", () => {
  it("splits the corpus into bounded requests rather than one call", async () => {
    const provider = new FlakyProvider(null, 2);
    await embedCorpus(provider, tmpDir, CORPUS);
    expect(provider.requests.map((r) => r.length)).toEqual([2, 2, 1]);
  });

  it("keeps the vectors from batches that completed before a failure", async () => {
    const provider = new FlakyProvider(3, 2); // batches 1 and 2 succeed, 3 throws

    await expect(embedCorpus(provider, tmpDir, CORPUS)).rejects.toThrow(/simulated OOM-kill/);

    const cached = loadCache(cachePath(tmpDir, provider), DIMS);
    expect([...cached.keys()].sort()).toEqual(["id:1", "id:2", "id:3", "id:4"]);
  });

  it("re-embeds only what is still missing after an interrupted run", async () => {
    const first = new FlakyProvider(3, 2);
    await expect(embedCorpus(first, tmpDir, CORPUS)).rejects.toThrow();

    const second = new FlakyProvider(null, 2);
    const result = await embedCorpus(second, tmpDir, CORPUS);

    // Only the one node the first run never reached.
    expect(second.requests.flat().length).toBe(1);
    expect(result.size).toBe(CORPUS.length);
  });

  it("produces the same vectors as an uninterrupted run", async () => {
    const cleanDir = mkdtempSync(join(tmpdir(), "reposkein-embed-resume-clean-"));
    try {
      const uninterrupted = await embedCorpus(new FlakyProvider(null, 2), cleanDir, CORPUS);

      await expect(embedCorpus(new FlakyProvider(3, 2), tmpDir, CORPUS)).rejects.toThrow();
      const resumed = await embedCorpus(new FlakyProvider(null, 2), tmpDir, CORPUS);

      for (const node of CORPUS) {
        expect(resumed.get(node.id)).toEqual(uninterrupted.get(node.id));
      }
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });

  it("writes nothing and re-embeds nothing when the very first request fails", async () => {
    const provider = new FlakyProvider(1, 2);
    await expect(embedCorpus(provider, tmpDir, CORPUS)).rejects.toThrow();
    const cached = loadCache(cachePath(tmpDir, provider), DIMS);
    expect(cached.size).toBe(0);
  });
});
