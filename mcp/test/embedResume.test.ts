/**
 * Incremental persistence, through the vector store.
 *
 * An interrupted cold run must leave the batches it already completed on disk,
 * so a re-run embeds only what is still missing. Before REP-37 the cache was
 * written once after the whole corpus succeeded, so an OOM-kill discarded every
 * vector computed and the next query reissued the identical request — a loop
 * that never made progress.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCorpusVectors, vectorBasePath } from "../src/embed/corpusVectors.js";
import { openVectorStore } from "../src/embed/vectorStore.js";
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

const reopen = (provider: EmbeddingProvider) =>
  openVectorStore(vectorBasePath(tmpDir, provider), DIMS);

describe("ensureCorpusVectors — incremental persistence", () => {
  it("splits the corpus into bounded requests rather than one call", async () => {
    const provider = new FlakyProvider(null, 2);
    await ensureCorpusVectors(provider, tmpDir, CORPUS);
    expect(provider.requests.map((r) => r.length)).toEqual([2, 2, 1]);
  });

  it("keeps the vectors from batches that completed before a failure", async () => {
    const provider = new FlakyProvider(3, 2); // batches 1 and 2 succeed, 3 throws

    await expect(ensureCorpusVectors(provider, tmpDir, CORPUS)).rejects.toThrow(
      /simulated OOM-kill/
    );

    const store = reopen(provider);
    expect(store.size).toBe(4);
    for (const id of ["id:1", "id:2", "id:3", "id:4"]) {
      expect(store.get(id), `${id} should have survived`).toBeDefined();
    }
  });

  it("re-embeds only what is still missing after an interrupted run", async () => {
    const first = new FlakyProvider(3, 2);
    await expect(ensureCorpusVectors(first, tmpDir, CORPUS)).rejects.toThrow();

    const second = new FlakyProvider(null, 2);
    const store = await ensureCorpusVectors(second, tmpDir, CORPUS);

    // Only the one node the first run never reached.
    expect(second.requests.flat().length).toBe(1);
    expect(store.size).toBe(CORPUS.length);
  });

  it("produces the same vectors as an uninterrupted run", async () => {
    const cleanDir = mkdtempSync(join(tmpdir(), "reposkein-embed-resume-clean-"));
    try {
      const clean = await ensureCorpusVectors(new FlakyProvider(null, 2), cleanDir, CORPUS);

      await expect(ensureCorpusVectors(new FlakyProvider(3, 2), tmpDir, CORPUS)).rejects.toThrow();
      const resumed = await ensureCorpusVectors(new FlakyProvider(null, 2), tmpDir, CORPUS);

      for (const node of CORPUS) {
        expect(Array.from(resumed.get(node.id)!)).toEqual(Array.from(clean.get(node.id)!));
      }
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });

  it("writes nothing when the very first request fails", async () => {
    const provider = new FlakyProvider(1, 2);
    await expect(ensureCorpusVectors(provider, tmpDir, CORPUS)).rejects.toThrow();
    expect(reopen(provider).size).toBe(0);
  });

  it("makes no request at all when every vector is already current", async () => {
    const first = new FlakyProvider(null, 2);
    await ensureCorpusVectors(first, tmpDir, CORPUS);

    const second = new FlakyProvider(null, 2);
    const store = await ensureCorpusVectors(second, tmpDir, CORPUS);
    expect(second.requests).toEqual([]);
    expect(store.size).toBe(CORPUS.length);
  });

  it("re-embeds a node whose document changed, and only that node", async () => {
    const first = new FlakyProvider(null, 2);
    await ensureCorpusVectors(first, tmpDir, CORPUS);

    const edited = CORPUS.map((n) =>
      n.id === "id:3" ? { ...n, summary: "now documented" } : n
    );
    const second = new FlakyProvider(null, 2);
    await ensureCorpusVectors(second, tmpDir, edited);

    expect(second.requests.flat().length).toBe(1);
  });

  it("refuses to store a vector of the wrong dimensionality", async () => {
    class WrongDims extends FlakyProvider {
      override async embedBatch(texts: string[], _kind: EmbedKind): Promise<number[][]> {
        return texts.map(() => [1, 2]); // declared 4
      }
    }
    await expect(
      ensureCorpusVectors(new WrongDims(null, 2), tmpDir, CORPUS)
    ).rejects.toThrow(/dims/);
  });
});
