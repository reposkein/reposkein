/**
 * The vector store: fixed-stride binary vectors, ranking behind the interface.
 *
 * The JSON-text cache this replaces cost 21,865 bytes per 1024-dim vector
 * against 4,096 for the floats themselves, handed them back as JS number
 * arrays at 8,252 bytes each, and did it all ON the V8 heap — whose limit here
 * is about 4.19 GB. It OOMed around 140k nodes, and re-read the whole file on
 * every query.
 *
 * These tests are about the interface, not the layout: what a caller can ask
 * for, and what it never has to know.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVectorStore, vectorStorePaths, type VectorStore } from "../src/embed/vectorStore.js";

const DIMS = 4;
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reposkein-vec-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = () => join(dir, "mock__model__d4");
const open = (): VectorStore => openVectorStore(base(), DIMS);

const v = (n: number) => [n, n + 0.5, n + 0.25, n + 0.75];

describe("VectorStore round-trip", () => {
  it("returns what it stored", () => {
    const s = open();
    s.upsertMany([{ id: "a", docHash: "h1", vector: v(1) }]);
    s.flush();
    expect(Array.from(s.get("a")!)).toEqual(v(1));
  });

  it("survives being reopened", () => {
    const s = open();
    s.upsertMany([
      { id: "a", docHash: "h1", vector: v(1) },
      { id: "b", docHash: "h2", vector: v(2) },
    ]);
    s.flush();

    const reopened = open();
    expect(Array.from(reopened.get("b")!)).toEqual(v(2));
    expect(reopened.docHash("a")).toBe("h1");
    expect(reopened.size).toBe(2);
  });

  it("reports a miss for an id it never held", () => {
    const s = open();
    expect(s.get("nope")).toBeUndefined();
    expect(s.docHash("nope")).toBeUndefined();
  });

  it("keeps the newest vector when an id is written twice", () => {
    const s = open();
    s.upsertMany([{ id: "a", docHash: "h1", vector: v(1) }]);
    s.flush();
    s.upsertMany([{ id: "a", docHash: "h2", vector: v(9) }]);
    s.flush();

    const reopened = open();
    expect(Array.from(reopened.get("a")!)).toEqual(v(9));
    expect(reopened.docHash("a")).toBe("h2");
    expect(reopened.size).toBe(1);
  });

  it("persists each batch as it lands, so an interrupted run resumes", () => {
    // The REP-37 property, carried over: a killed cold run must not lose the
    // vectors it already computed.
    const s = open();
    s.upsertMany([{ id: "a", docHash: "h1", vector: v(1) }]);
    s.flush();
    // No further flush — simulate the process dying here.

    const reopened = open();
    expect(reopened.size).toBe(1);
    expect(Array.from(reopened.get("a")!)).toEqual(v(1));
  });
});

describe("VectorStore keeps vectors off the JS heap", () => {
  it("hands back a typed array, not a number[]", () => {
    const s = open();
    s.upsertMany([{ id: "a", docHash: "h1", vector: v(1) }]);
    s.flush();
    // number[] would be ~2x the bytes and would count against the heap limit.
    expect(s.get("a")).toBeInstanceOf(Float32Array);
  });

  it("stores exactly four bytes per dimension", () => {
    const s = open();
    s.upsertMany([
      { id: "a", docHash: "h1", vector: v(1) },
      { id: "b", docHash: "h2", vector: v(2) },
    ]);
    s.flush();
    expect(statSync(vectorStorePaths(base()).vectors).size).toBe(2 * DIMS * 4);
  });
});

describe("VectorStore.topK", () => {
  const seed = (s: VectorStore) => {
    s.upsertMany([
      { id: "exact", docHash: "h", vector: [1, 0, 0, 0] },
      { id: "close", docHash: "h", vector: [0.9, 0.1, 0, 0] },
      { id: "orthogonal", docHash: "h", vector: [0, 1, 0, 0] },
      { id: "opposite", docHash: "h", vector: [-1, 0, 0, 0] },
    ]);
    s.flush();
  };

  it("ranks by cosine similarity, best first", () => {
    const s = open();
    seed(s);
    expect(s.topK([1, 0, 0, 0], 4).map((r) => r.id)).toEqual([
      "exact",
      "close",
      "orthogonal",
      "opposite",
    ]);
  });

  it("returns at most k, so allocation tracks the limit and not the corpus", () => {
    const s = open();
    seed(s);
    const top = s.topK([1, 0, 0, 0], 2);
    expect(top).toHaveLength(2);
    expect(top.map((r) => r.id)).toEqual(["exact", "close"]);
  });

  it("scores an exact match at 1 and its opposite at -1", () => {
    const s = open();
    seed(s);
    const ranked = s.topK([1, 0, 0, 0], 4);
    expect(ranked[0]!.score).toBeCloseTo(1, 5);
    expect(ranked[3]!.score).toBeCloseTo(-1, 5);
  });

  it("can be restricted to a set of candidate ids", () => {
    const s = open();
    seed(s);
    const ranked = s.topK([1, 0, 0, 0], 4, new Set(["orthogonal", "opposite"]));
    expect(ranked.map((r) => r.id)).toEqual(["orthogonal", "opposite"]);
  });

  it("is empty for an empty store rather than throwing", () => {
    expect(open().topK([1, 0, 0, 0], 5)).toEqual([]);
  });

  it("skips a zero vector rather than dividing by zero", () => {
    const s = open();
    s.upsertMany([
      { id: "zero", docHash: "h", vector: [0, 0, 0, 0] },
      { id: "real", docHash: "h", vector: [1, 0, 0, 0] },
    ]);
    s.flush();
    const ranked = s.topK([1, 0, 0, 0], 5);
    expect(ranked.map((r) => r.id)).toEqual(["real"]);
  });
});

describe("VectorStore is defensive about what it reads", () => {
  it("starts empty when nothing has been written", () => {
    const s = open();
    expect(s.size).toBe(0);
    expect(s.get("a")).toBeUndefined();
  });

  it("drops index rows with no vector behind them", () => {
    // A torn write: the index line landed, the vector bytes did not.
    writeFileSync(vectorStorePaths(base()).index, `{"id":"a","doc_hash":"h1"}\n`);
    writeFileSync(vectorStorePaths(base()).vectors, Buffer.alloc(0));
    const s = open();
    expect(s.get("a")).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it("ignores a malformed index line instead of failing the query", () => {
    const s = open();
    s.upsertMany([{ id: "a", docHash: "h1", vector: v(1) }]);
    s.flush();
    const p = vectorStorePaths(base());
    writeFileSync(p.index, `not json\n${`{"id":"a","doc_hash":"h1"}`}\n`);
    expect(open().size).toBe(1);
  });

  it("discards a store written for a different dimensionality", () => {
    const s = open();
    s.upsertMany([{ id: "a", docHash: "h1", vector: v(1) }]);
    s.flush();

    // Same file, a client now configured for 8 dims: the bytes mean something
    // else entirely, and scoring them would be silently wrong.
    const other = openVectorStore(base(), 8);
    expect(other.size).toBe(0);
  });
});

describe("vectorStorePaths", () => {
  it("keeps the vectors and the index beside each other", () => {
    const p = vectorStorePaths("/repo/.reposkein/local/embeddings/x__y__d1024");
    expect(p.vectors).toMatch(/x__y__d1024\.vec$/);
    expect(p.index).toMatch(/x__y__d1024\.idx\.jsonl$/);
  });

  it("names files that did not exist under the old JSON scheme", () => {
    // The legacy cache was <name>.jsonl. Different names mean an old cache is
    // never read as if it were the new format.
    const p = vectorStorePaths("/x/name");
    expect(p.vectors.endsWith(".jsonl")).toBe(false);
    expect(existsSync(p.vectors)).toBe(false);
  });
});
