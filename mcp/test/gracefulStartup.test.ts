import { describe, it, expect } from "vitest";
import { UnconfiguredStore } from "../src/store/UnconfiguredStore.js";
import { makeReadCypher } from "../src/tools/readCypher.js";
import { makeGetContextProfile } from "../src/tools/getContextProfile.js";
import { makeWriteSemanticSummary } from "../src/tools/writeSemanticSummary.js";
import { makeInitCpgSkeleton, makeReindexFile } from "../src/tools/indexerTools.js";

describe("graceful startup without NEO4J_PASSWORD", () => {
  it("UnconfiguredStore.runRead rejects with a Neo4j configuration message", async () => {
    const store = new UnconfiguredStore();
    await expect(store.runRead("MATCH (n) RETURN n")).rejects.toThrow(/Neo4j/i);
  });

  it("points at the repo path first, not at standing up a database", async () => {
    // The usual cause of an unconfigured store is a missing REPOSKEIN_REPO_PATH.
    // Leading with Neo4j sends a zero-infra user off to install infrastructure
    // they do not need to answer a single query.
    const store = new UnconfiguredStore();
    await expect(store.runRead("MATCH (n) RETURN n")).rejects.toThrow(/REPOSKEIN_REPO_PATH/);
    await expect(store.runRead("MATCH (n) RETURN n")).rejects.toThrow(/reposkein-mcp index/);
    await expect(store.runRead("MATCH (n) RETURN n")).rejects.toThrow(/git-ignored/);
  });

  it("UnconfiguredStore.writeSummary rejects with a Neo4j configuration message", async () => {
    const store = new UnconfiguredStore();
    await expect(
      store.writeSummary("repo", "id", { summary: "x", model: "m", at: "2026-06-12", by: "agent" })
    ).rejects.toThrow(/Neo4j/i);
  });

  it("read_cypher with UnconfiguredStore returns isError mentioning Neo4j", async () => {
    const store = new UnconfiguredStore();
    const handler = makeReadCypher(store, "somerepo");
    const res = await handler({ query: "MATCH (n) RETURN n" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Neo4j/i);
  });

  it("all five tool handlers can be constructed (server registers all tools)", () => {
    const store = new UnconfiguredStore();
    const repoId = "testrepo";
    // These constructors must not throw — the server always registers all 5 tools
    expect(() => makeReadCypher(store, repoId)).not.toThrow();
    expect(() => makeGetContextProfile(store, repoId)).not.toThrow();
    expect(() => makeWriteSemanticSummary(store, repoId)).not.toThrow();
    expect(() => makeInitCpgSkeleton(repoId, "/tmp/testrepo")).not.toThrow();
    expect(() => makeReindexFile(repoId, "/tmp/testrepo")).not.toThrow();
  });

  it("get_context_profile with UnconfiguredStore returns isError mentioning Neo4j", async () => {
    const store = new UnconfiguredStore();
    const handler = makeGetContextProfile(store, "testrepo");
    const res = await handler({ name: "someFunction" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Neo4j/i);
  });

  it("JsonlGraphStore.runRead throws CypherUnsupportedError (no Cypher engine)", async () => {
    const { JsonlGraphStore } = await import("../src/store/JsonlGraphStore.js");
    const { CypherUnsupportedError } = await import("../src/store/GraphStore.js");
    // Point at a nonexistent repo dir → empty graph; runRead still throws.
    const store = new JsonlGraphStore("/nonexistent-reposkein-path", "norepo");
    await expect(store.runRead()).rejects.toBeInstanceOf(CypherUnsupportedError);
  });
});
