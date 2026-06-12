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

  it("UnconfiguredStore.runWrite rejects with a Neo4j configuration message", async () => {
    const store = new UnconfiguredStore();
    await expect(store.runWrite("CREATE (n) RETURN n")).rejects.toThrow(/Neo4j/i);
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
    expect(() => makeInitCpgSkeleton(repoId)).not.toThrow();
    expect(() => makeReindexFile(repoId)).not.toThrow();
  });

  it("get_context_profile with UnconfiguredStore returns isError mentioning Neo4j", async () => {
    const store = new UnconfiguredStore();
    const handler = makeGetContextProfile(store, "testrepo");
    const res = await handler({ name: "someFunction" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Neo4j/i);
  });
});
