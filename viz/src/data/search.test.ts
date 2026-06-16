import { describe, it, expect } from "vitest";
import { rankSearch } from "./search";
import type { NodeRecord } from "./model";

function rec(
  id: string,
  name: string,
  opts: Partial<NodeRecord> = {}
): NodeRecord {
  return {
    id,
    name,
    qualifiedName: opts.qualifiedName ?? name,
    kind: "Function",
    filePath: opts.filePath ?? "",
    startLine: 0,
    endLine: 0,
    language: "",
    role: "",
    semanticSummary: opts.semanticSummary ?? null,
    summaryOfHash: null,
    contentHash: null,
    degree: 0,
  };
}

describe("ranked search ordering", () => {
  it("ranks a name match above a file_path match for the same query", () => {
    const recs = [
      rec("a", "parseGraph"), // name hit
      rec("b", "helper", { filePath: "src/parseGraph/util.ts" }), // path hit
    ];
    const hits = rankSearch(recs, "parsegraph");
    expect(hits[0]!.rec.id).toBe("a");
    expect(hits[0]!.topField).toBe("name");
    expect(hits[1]!.rec.id).toBe("b");
    expect(hits[1]!.topField).toBe("filePath");
  });

  it("ranks an exact name match above a substring name match", () => {
    const recs = [
      rec("a", "loadConfigFromDisk"), // substring
      rec("b", "config"), // exact
    ];
    const hits = rankSearch(recs, "config");
    expect(hits[0]!.rec.id).toBe("b");
  });

  it("ranks a prefix match above a mid-word substring match", () => {
    const recs = [
      rec("a", "xparser"), // mid-word substring
      rec("b", "parserFactory"), // prefix
    ];
    const hits = rankSearch(recs, "parser");
    expect(hits[0]!.rec.id).toBe("b");
  });

  it("requires every token to match (AND semantics)", () => {
    const recs = [
      rec("a", "userService", { filePath: "src/auth/userService.ts" }),
      rec("b", "userService", { filePath: "src/data/userService.ts" }),
    ];
    const hits = rankSearch(recs, "user auth");
    expect(hits.map((h) => h.rec.id)).toEqual(["a"]);
  });

  it("matches the semantic summary as a low-weight field", () => {
    const recs = [
      rec("a", "foo", { semanticSummary: "handles websocket reconnection" }),
      rec("b", "bar"),
    ];
    const hits = rankSearch(recs, "websocket");
    expect(hits.map((h) => h.rec.id)).toEqual(["a"]);
    expect(hits[0]!.topField).toBe("semanticSummary");
  });

  it("is deterministic on score ties (name then id)", () => {
    const recs = [
      rec("z2", "config"),
      rec("z1", "config"),
      rec("a1", "config"),
    ];
    const hits = rankSearch(recs, "config");
    // All identical score → ordered by id ascending.
    expect(hits.map((h) => h.rec.id)).toEqual(["a1", "z1", "z2"]);
  });

  it("respects the result limit", () => {
    const recs = Array.from({ length: 20 }, (_, i) => rec(`n${i}`, "config"));
    const hits = rankSearch(recs, "config", 5);
    expect(hits).toHaveLength(5);
  });

  it("returns nothing for a blank query", () => {
    expect(rankSearch([rec("a", "foo")], "   ")).toEqual([]);
  });
});
