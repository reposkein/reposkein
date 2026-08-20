import { describe, it, expect } from "vitest";
import { collectSourceSlices } from "../src/cli/sourceSlices.js";

const NODES = [
  JSON.stringify({
    id: "rs1:demo:func:a.py#f@0",
    labels: ["Function"],
    props: { name: "f", file_path: "a.py", start_line: 2, end_line: 3 },
  }),
  JSON.stringify({
    id: "rs1:demo:func:a.py#g@1",
    labels: ["Function"],
    props: { name: "g", file_path: "a.py", start_line: 5, end_line: 5 },
  }),
  // No start/end lines — a File node, not sliceable.
  JSON.stringify({ id: "rs1:demo:file:a.py", labels: ["File"], props: { path: "a.py" } }),
].join("\n") + "\n";

const FILES: Record<string, string> = {
  "a.py": "line1\nline2\nline3\nline4\nline5\nline6\n",
};

function readFile(absPath: string): string {
  const name = absPath.split("/").pop()!;
  const text = FILES[name];
  if (text === undefined) throw new Error(`ENOENT: ${absPath}`);
  return text;
}

describe("collectSourceSlices", () => {
  it("slices 1-based inclusive [start,end] ranges for nodes with line info", () => {
    const out = collectSourceSlices("/repo", NODES, 1_000_000, { readFile });
    expect(out["rs1:demo:func:a.py#f@0"]).toEqual({
      path: "a.py",
      start: 2,
      end: 3,
      lines: ["line2", "line3"],
    });
    expect(out["rs1:demo:func:a.py#g@1"]).toEqual({
      path: "a.py",
      start: 5,
      end: 5,
      lines: ["line5"],
    });
  });

  it("skips nodes without a sliceable file_path/start_line/end_line", () => {
    const out = collectSourceSlices("/repo", NODES, 1_000_000, { readFile });
    expect(out["rs1:demo:file:a.py"]).toBeUndefined();
  });

  it("stops once the running total would exceed maxBytes (deterministic, first-in-order wins)", () => {
    const out = collectSourceSlices("/repo", NODES, 1, { readFile });
    expect(Object.keys(out)).toEqual([]);
  });

  it("skips a file that fails to read, without throwing", () => {
    const nodes =
      JSON.stringify({
        id: "n1",
        props: { file_path: "missing.py", start_line: 1, end_line: 1 },
      }) + "\n";
    expect(() => collectSourceSlices("/repo", nodes, 1_000_000, { readFile })).not.toThrow();
    expect(collectSourceSlices("/repo", nodes, 1_000_000, { readFile })).toEqual({});
  });

  it("ignores malformed JSON lines", () => {
    const nodes = "not json\n" + NODES;
    const out = collectSourceSlices("/repo", nodes, 1_000_000, { readFile });
    expect(Object.keys(out)).toHaveLength(2);
  });
});
