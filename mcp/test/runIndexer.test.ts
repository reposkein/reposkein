import { describe, it, expect } from "vitest";
import { parseIndexStats } from "../src/indexer/runIndexer.js";

describe("parseIndexStats", () => {
  it("extracts node and edge counts from indexer stdout", () => {
    const out = "indexed repo_id=abc name=demo: 27 nodes, 25 edges\n";
    expect(parseIndexStats(out)).toEqual({ nodes: 27, edges: 25 });
  });

  it("returns zeros when the line is absent", () => {
    expect(parseIndexStats("nothing here")).toEqual({ nodes: 0, edges: 0 });
  });
});
