import { describe, it, expect, afterEach } from "vitest";
import { parseJsonStats, shouldLoadNeo4j } from "../src/indexer/runIndexer.js";

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

describe("shouldLoadNeo4j", () => {
  const saved = { store: process.env.REPOSKEIN_STORE, pw: process.env.NEO4J_PASSWORD };
  afterEach(() => {
    if (saved.store === undefined) delete process.env.REPOSKEIN_STORE;
    else process.env.REPOSKEIN_STORE = saved.store;
    if (saved.pw === undefined) delete process.env.NEO4J_PASSWORD;
    else process.env.NEO4J_PASSWORD = saved.pw;
  });

  it("is false in explicit jsonl mode even with a password", () => {
    process.env.REPOSKEIN_STORE = "jsonl";
    process.env.NEO4J_PASSWORD = "x";
    expect(shouldLoadNeo4j()).toBe(false);
  });

  it("is false in auto mode without a password (zero-infra)", () => {
    delete process.env.REPOSKEIN_STORE;
    delete process.env.NEO4J_PASSWORD;
    expect(shouldLoadNeo4j()).toBe(false);
  });

  it("is true in auto mode with a password", () => {
    delete process.env.REPOSKEIN_STORE;
    process.env.NEO4J_PASSWORD = "x";
    expect(shouldLoadNeo4j()).toBe(true);
  });

  it("is true in neo4j mode with a password", () => {
    process.env.REPOSKEIN_STORE = "neo4j";
    process.env.NEO4J_PASSWORD = "x";
    expect(shouldLoadNeo4j()).toBe(true);
  });
});
