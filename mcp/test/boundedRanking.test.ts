/**
 * Bounded ranking: caps applied where the work happens, not after it.
 *
 * Two separate problems the old shape had. BM25F retained a tokenized copy of
 * every field of every corpus node through scoring, then collected every
 * positive-scoring document before sorting — so a query's allocation tracked
 * the corpus. And `read_cypher`'s 200-row cap was applied AFTER the driver had
 * buffered the whole result, so `MATCH (n) RETURN n` pulled the entire database
 * into heap to hand back 200 rows.
 */

import { describe, it, expect } from "vitest";
import { rankCorpus } from "../src/search/bm25f.js";
import { makeReadCypher } from "../src/tools/readCypher.js";
import { MAX_ROWS } from "../src/guard/caps.js";
import type { CorpusNode, GraphStore } from "../src/store/GraphStore.js";

function cn(id: string, qn: string, summary = ""): CorpusNode {
  return {
    id,
    kind: "Function",
    name: qn.split(".").pop() ?? qn,
    qualified_name: qn,
    signature: "()",
    summary,
    file_path: "src/a.ts",
    repo_id: "r",
  };
}

const CORPUS: CorpusNode[] = [
  cn("id:1", "auth.validateToken", "validates a jwt token for the session"),
  cn("id:2", "auth.refreshToken", "refreshes an expired jwt token"),
  cn("id:3", "billing.charge", "charges a card"),
  cn("id:4", "user.token", "token helper"),
  cn("id:5", "util.noise", "nothing relevant here"),
];

describe("rankCorpus bounding", () => {
  it("returns no more than the limit", () => {
    expect(rankCorpus(CORPUS, "token", 2)).toHaveLength(2);
  });

  it("returns the same top-k as ranking everything and slicing", () => {
    // The bounded heap must not change WHICH nodes win, only how many are
    // retained on the way there.
    const all = rankCorpus(CORPUS, "token", CORPUS.length);
    const top2 = rankCorpus(CORPUS, "token", 2);
    expect(top2.map((r) => r.node.id)).toEqual(all.slice(0, 2).map((r) => r.node.id));
    expect(top2.map((r) => r.score)).toEqual(all.slice(0, 2).map((r) => r.score));
  });

  it("scores identically whichever limit is asked for", () => {
    const wide = rankCorpus(CORPUS, "jwt token", 100);
    const narrow = rankCorpus(CORPUS, "jwt token", 1);
    expect(narrow[0]!.score).toBe(wide[0]!.score);
    expect(narrow[0]!.node.id).toBe(wide[0]!.node.id);
  });

  it("breaks ties by ascending id, at the boundary too", () => {
    // Two nodes with identical text score identically; the lower id must win
    // the last slot rather than whichever happened to be visited first.
    const tied = [cn("id:b", "same.name", "same text"), cn("id:a", "same.name", "same text")];
    const [first] = rankCorpus(tied, "same", 1);
    expect(first!.node.id).toBe("id:a");
  });

  it("accepts a re-iterable generator, not just an array", () => {
    // The seam: production streams the corpus, tests pass arrays. BM25F needs
    // two passes for corpus statistics, so the iterable must be re-iterable.
    const gen = { [Symbol.iterator]: () => CORPUS[Symbol.iterator]() };
    expect(rankCorpus(gen, "token", 3).map((r) => r.node.id)).toEqual(
      rankCorpus(CORPUS, "token", 3).map((r) => r.node.id)
    );
  });

  it("is empty for a zero limit rather than ranking the corpus first", () => {
    expect(rankCorpus(CORPUS, "token", 0)).toEqual([]);
  });

  it("is empty for an empty corpus", () => {
    expect(rankCorpus([], "token", 10)).toEqual([]);
  });
});

/** Records what the tool asked the store for. */
function recordingStore(rowCount: number) {
  const seen: Array<{ maxRows?: number }> = [];
  const store = {
    async runRead(_q: string, _p?: Record<string, unknown>, opts?: { maxRows?: number }) {
      seen.push({ maxRows: opts?.maxRows });
      // Honour the cap the way a streaming store would.
      const n = opts?.maxRows === undefined ? rowCount : Math.min(rowCount, opts.maxRows + 1);
      return Array.from({ length: n }, (_, i) => ({ i }));
    },
  } as unknown as GraphStore;
  return { store, seen };
}

describe("read_cypher caps before materialising", () => {
  it("asks the store to stop streaming at the row cap", async () => {
    const { store, seen } = recordingStore(1_000_000);
    await makeReadCypher(store, "r")({ query: "MATCH (n) RETURN n" });
    expect(seen[0]!.maxRows).toBe(MAX_ROWS);
  });

  it("still reports truncation to the caller", async () => {
    const { store } = recordingStore(1_000_000);
    const res = await makeReadCypher(store, "r")({ query: "MATCH (n) RETURN n" });
    const body = JSON.parse((res.content[0] as { text: string }).text);
    expect(body.truncated).toBe(true);
    expect(body.rows).toHaveLength(MAX_ROWS);
  });

  it("does not report truncation when the result fits", async () => {
    const { store } = recordingStore(3);
    const res = await makeReadCypher(store, "r")({ query: "MATCH (n) RETURN n LIMIT 3" });
    const body = JSON.parse((res.content[0] as { text: string }).text);
    expect(body.truncated).toBe(false);
    expect(body.rows).toHaveLength(3);
  });
});
