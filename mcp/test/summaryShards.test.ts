import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  absorbSummaryLines,
  beats,
  conflictsPath,
  countRecordedConflicts,
  isConflictMarker,
  isShardFileName,
  loadSummaryShards,
  recordSummaryConflicts,
  summariesDir,
  type SummaryShardRecord,
} from "../src/store/summaryShards.js";

/** The shared cross-language fixture. Asserted here AND by
 *  indexer/crates/core/tests/summary_vectors.rs — the Rust indexer writes the
 *  shards and this module reads them, so a drift between the two would have
 *  the server serving prose the next index is about to replace. */
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "summary-shard-vectors.json"
);

interface DedupeCase {
  name: string;
  lines: string[];
  winners: Record<string, string>;
  conflicts: string[];
  skipped: number;
}

function loadFixture(): { dedupe: { cases: DedupeCase[] } } {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as { dedupe: { cases: DedupeCase[] } };
}

function fold(lines: string[]) {
  const acc = {
    summaries: new Map<string, SummaryShardRecord>(),
    conflicts: [] as SummaryShardRecord[],
    warnings: [] as string[],
  };
  absorbSummaryLines(acc, "fixture", lines.map((l) => `${l}\n`).join(""));
  return acc;
}

describe("summary shard vectors (cross-language contract)", () => {
  const { dedupe } = loadFixture();

  it("has cases", () => {
    expect(dedupe.cases.length).toBeGreaterThan(0);
  });

  for (const c of dedupe.cases) {
    it(`resolves: ${c.name}`, () => {
      const acc = fold(c.lines);

      const gotWinners = Object.fromEntries([...acc.summaries].map(([id, r]) => [id, r.line]));
      expect(gotWinners).toEqual(c.winners);

      // Conflict ORDER is an implementation detail; membership is the contract,
      // so both suites compare sorted.
      expect(acc.conflicts.map((r) => r.line).sort()).toEqual([...c.conflicts].sort());

      const skipped = acc.warnings.reduce((n, w) => {
        const m = /(\d+)/.exec(w);
        return n + (m ? Number(m[1]) : 0);
      }, 0);
      expect(skipped).toBe(c.skipped);
    });
  }
});

describe("summary shard reader", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-shards-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const shard = (name: string, text: string) => {
    mkdirSync(summariesDir(root), { recursive: true });
    writeFileSync(join(summariesDir(root), name), text);
  };
  const line = (id: string, summary: string, at?: string) =>
    at === undefined
      ? `{"id":"${id}","semantic_summary":"${summary}"}`
      : `{"id":"${id}","semantic_summary":"${summary}","summary_at":"${at}"}`;

  it("returns empty for a repo with no summaries at all", () => {
    const loaded = loadSummaryShards(root);
    expect(loaded.summaries.size).toBe(0);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.legacyFilePresent).toBe(false);
  });

  it("reads every shard and keys by node id", () => {
    shard("00.jsonl", `${line("a", "alpha")}\n`);
    shard("ff.jsonl", `${line("z", "zulu")}\n`);
    const loaded = loadSummaryShards(root);
    expect([...loaded.summaries.keys()]).toEqual(["a", "z"]);
    expect(loaded.summaries.get("a")!.props.semantic_summary).toBe("alpha");
  });

  it("ignores files that are not shards", () => {
    shard("00.jsonl", `${line("a", "alpha")}\n`);
    shard("README.md", "not a shard\n");
    shard("0.jsonl", `${line("b", "bravo")}\n`);
    shard("FF.jsonl", `${line("c", "charlie")}\n`);
    expect([...loadSummaryShards(root).summaries.keys()]).toEqual(["a"]);
  });

  it("iterates shards in a stable id order regardless of file order", () => {
    shard("ff.jsonl", `${line("m", "mike")}\n`);
    shard("00.jsonl", `${line("z", "zulu")}\n`);
    shard("7a.jsonl", `${line("a", "alpha")}\n`);
    expect([...loadSummaryShards(root).summaries.keys()]).toEqual(["a", "m", "z"]);
  });

  it("dual-reads the pre-sharding summaries.jsonl and flags it", () => {
    shard("00.jsonl", `${line("a", "from a shard")}\n`);
    mkdirSync(join(root, ".reposkein"), { recursive: true });
    writeFileSync(join(root, ".reposkein", "summaries.jsonl"), `${line("b", "from the old file")}\n`);
    const loaded = loadSummaryShards(root);
    expect(loaded.legacyFilePresent).toBe(true);
    expect([...loaded.summaries.keys()]).toEqual(["a", "b"]);
  });

  // -------------------------------------------------------------------------
  // The two-branch merge: the scenario the sharding exists for
  // -------------------------------------------------------------------------

  it("survives a shard left with conflict markers, keeping both sides", () => {
    shard(
      "00.jsonl",
      `<<<<<<< HEAD\n${line("a", "ours")}\n=======\n${line("b", "theirs")}\n>>>>>>> feature/other\n`
    );
    const loaded = loadSummaryShards(root);
    expect([...loaded.summaries.keys()]).toEqual(["a", "b"]);
    expect(loaded.warnings.join(" ")).toContain("conflict-marker");
    expect(loaded.conflicts).toEqual([]);
  });

  it("collapses union-merge duplicates without calling them conflicts", () => {
    const l = line("a", "same");
    shard("00.jsonl", `${l}\n${l}\n`);
    const loaded = loadSummaryShards(root);
    expect(loaded.summaries.size).toBe(1);
    expect(loaded.conflicts).toEqual([]);
  });

  it("resolves two divergent branches identically whichever side git wrote first", () => {
    const ours = line("a", "ours: the constant one", "2026-08-19T10:00:00Z");
    const theirs = line("a", "theirs: the identity of one", "2026-08-20T10:00:00Z");

    const resolve = (first: string, second: string) => {
      const dir = mkdtempSync(join(tmpdir(), "reposkein-merge-"));
      mkdirSync(summariesDir(dir), { recursive: true });
      writeFileSync(
        join(summariesDir(dir), "00.jsonl"),
        `<<<<<<< HEAD\n${first}\n=======\n${second}\n>>>>>>> other\n`
      );
      const loaded = loadSummaryShards(dir);
      rmSync(dir, { recursive: true, force: true });
      return loaded;
    };

    const a = resolve(ours, theirs);
    const b = resolve(theirs, ours);
    expect(a.summaries.get("a")!.line).toBe(theirs);
    expect(b.summaries.get("a")!.line).toBe(theirs);
    expect(a.conflicts.map((c) => c.line)).toEqual([ours]);
    expect(b.conflicts.map((c) => c.line)).toEqual([ours]);
  });

  it("preserves the loser to local/conflicts.jsonl rather than dropping it", () => {
    const older = line("a", "older prose", "2026-08-19T10:00:00Z");
    const newer = line("a", "newer prose", "2026-08-20T10:00:00Z");
    shard("00.jsonl", `${older}\n${newer}\n`);
    const loaded = loadSummaryShards(root);
    recordSummaryConflicts(root, loaded.conflicts);
    const text = readFileSync(conflictsPath(root), "utf8");
    expect(text).toContain("older prose");
    expect(countRecordedConflicts(root)).toBe(1);
  });

  it("never grows the conflicts file by re-recording the same loser", () => {
    const older = line("a", "older prose", "2026-08-19T10:00:00Z");
    const newer = line("a", "newer prose", "2026-08-20T10:00:00Z");
    shard("00.jsonl", `${older}\n${newer}\n`);
    for (let i = 0; i < 5; i++) recordSummaryConflicts(root, loadSummaryShards(root).conflicts);
    expect(countRecordedConflicts(root)).toBe(1);
  });

  it("never forgets an earlier loser when a new one arrives", () => {
    const first: SummaryShardRecord = { id: "a", props: {}, line: line("a", "first loser") };
    const second: SummaryShardRecord = { id: "b", props: {}, line: line("b", "second loser") };
    recordSummaryConflicts(root, [first]);
    recordSummaryConflicts(root, [second]);
    const text = readFileSync(conflictsPath(root), "utf8");
    expect(text).toContain("first loser");
    expect(text).toContain("second loser");
  });

  it("writes no conflicts file when there is nothing to record", () => {
    recordSummaryConflicts(root, []);
    expect(existsSync(conflictsPath(root))).toBe(false);
  });

  it("skips malformed lines without losing the valid ones", () => {
    shard("00.jsonl", `not json\n{"semantic_summary":"no id"}\n\n${line("a", "kept")}\n`);
    const loaded = loadSummaryShards(root);
    expect([...loaded.summaries.keys()]).toEqual(["a"]);
    expect(loaded.warnings.join(" ")).toContain("malformed");
  });

  it("rejects a JSON array line as malformed rather than reading it as a record", () => {
    shard("00.jsonl", `[1,2,3]\n${line("a", "kept")}\n`);
    expect([...loadSummaryShards(root).summaries.keys()]).toEqual(["a"]);
  });
});

describe("summary shard primitives", () => {
  it("recognises shard file names the way the indexer writes them", () => {
    expect(isShardFileName("00.jsonl")).toBe(true);
    expect(isShardFileName("ff.jsonl")).toBe(true);
    expect(isShardFileName("FF.jsonl")).toBe(false);
    expect(isShardFileName("0.jsonl")).toBe(false);
    expect(isShardFileName("000.jsonl")).toBe(false);
    expect(isShardFileName("zz.jsonl")).toBe(false);
  });

  it("recognises every git conflict-marker form", () => {
    for (const m of ["<<<<<<< HEAD", "=======", ">>>>>>> other", "||||||| base"]) {
      expect(isConflictMarker(m)).toBe(true);
    }
    expect(isConflictMarker('{"id":"a"}')).toBe(false);
  });

  it("compares raw lines by utf-8 byte order, not utf-16 code units", () => {
    // U+FFFD (3 utf-8 bytes, one utf-16 unit) vs U+10000 (4 utf-8 bytes, a
    // surrogate pair). UTF-16 order puts the surrogate pair FIRST; UTF-8 byte
    // order puts it last. Rust compares bytes, so this must too.
    const bmp: SummaryShardRecord = { id: "a", props: {}, line: `{"x":"�"}` };
    const astral: SummaryShardRecord = { id: "a", props: {}, line: `{"x":"\u{10000}"}` };
    expect(bmp.line < astral.line).toBe(false); // what naive `<` would say
    expect(beats(bmp, astral)).toBe(true); // what byte order says
  });
});
