/**
 * The synchronous JSONL line reader.
 *
 * The graph load stays synchronous because `ensureFresh` is called from every
 * store method, so `readline` is unavailable. That leaves reading through a
 * fixed buffer — and the interesting cases are all at the buffer's edges.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLines } from "../src/store/jsonlLines.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reposkein-lines-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (content: string | Buffer, name = "f.jsonl") => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};
const read = (p: string) => [...readLines(p)];

describe("readLines", () => {
  it("yields each line", () => {
    expect(read(write("a\nb\nc\n"))).toEqual(["a", "b", "c"]);
  });

  it("yields a final line with no trailing newline", () => {
    expect(read(write("a\nb"))).toEqual(["a", "b"]);
  });

  it("skips blank and whitespace-only lines", () => {
    expect(read(write("a\n\n   \nb\n"))).toEqual(["a", "b"]);
  });

  it("is empty for an empty file", () => {
    expect(read(write(""))).toEqual([]);
  });

  it("treats a missing file as empty rather than throwing", () => {
    expect(read(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("reads a file far larger than one buffer", () => {
    // The buffer is 64 KiB; this is several times that, so every boundary case
    // below is actually exercised rather than fitting in one read.
    const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(60) }));
    const got = read(write(lines.join("\n") + "\n"));
    expect(got).toHaveLength(5000);
    expect(JSON.parse(got[0]!).i).toBe(0);
    expect(JSON.parse(got[4999]!).i).toBe(4999);
  });

  it("keeps a line intact when it spans a buffer boundary", () => {
    const huge = "z".repeat(200_000); // longer than the 64 KiB buffer on its own
    const got = read(write(`first\n${huge}\nlast\n`));
    expect(got).toEqual(["first", huge, "last"]);
  });

  it("does not corrupt a multi-byte character split across a buffer edge", () => {
    // The bug this guards: a plain buf.toString() decodes each chunk
    // independently, so a UTF-8 sequence straddling the edge becomes two U+FFFD
    // replacement characters. Identifiers and authored summaries are not ASCII.
    const filler = "a".repeat(65_534); // pushes the é onto the boundary
    const line = `${filler}é${"b".repeat(10)}`;
    const got = read(write(`${line}\n`));
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(line);
    expect(got[0]).not.toContain("�");
  });

  it("round-trips emoji and CJK across many boundaries", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${"漢字".repeat(80)}🧵${i}`);
    expect(read(write(lines.join("\n") + "\n"))).toEqual(lines);
  });

  it("is lazy — a consumer that stops early does not read the whole file", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line${i}`);
    const p = write(lines.join("\n") + "\n");
    const it = readLines(p);
    expect(it.next().value).toBe("line0");
    it.return?.(undefined); // closes the descriptor via the generator's finally
  });

  it("can be iterated more than once from the same path", () => {
    const p = write("a\nb\n");
    expect(read(p)).toEqual(["a", "b"]);
    expect(read(p)).toEqual(["a", "b"]);
  });
});
