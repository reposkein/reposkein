import { describe, it, expect } from "vitest";
import { parseIndexStats, parseJsonStats } from "../src/indexer/runIndexer.js";

describe("parseIndexStats (legacy)", () => {
  it("extracts node and edge counts from indexer stdout", () => {
    const out = "indexed repo_id=abc name=demo: 27 nodes, 25 edges\n";
    expect(parseIndexStats(out)).toEqual({ nodes: 27, edges: 25 });
  });

  it("returns zeros when the line is absent", () => {
    expect(parseIndexStats("nothing here")).toEqual({ nodes: 0, edges: 0 });
  });
});

describe("parseJsonStats", () => {
  it("parses a valid index --json object", () => {
    const json = JSON.stringify({
      repo_id: "abc",
      files: 3,
      nodes: 27,
      edges: 25,
      children: 0,
      warnings: [],
    });
    const result = parseJsonStats(json);
    expect(result).not.toBeNull();
    expect(result?.repo_id).toBe("abc");
    expect(result?.files).toBe(3);
    expect(result?.nodes).toBe(27);
    expect(result?.edges).toBe(25);
    expect(result?.children).toBe(0);
    expect(result?.warnings).toEqual([]);
  });

  it("parses JSON with warnings", () => {
    const json = JSON.stringify({
      repo_id: "r",
      files: 1,
      nodes: 5,
      edges: 2,
      children: 0,
      warnings: ["some warning"],
    });
    const result = parseJsonStats(json);
    expect(result?.warnings).toEqual(["some warning"]);
  });

  it("returns null for non-JSON output", () => {
    expect(parseJsonStats("not json at all")).toBeNull();
    expect(parseJsonStats("")).toBeNull();
  });
});
