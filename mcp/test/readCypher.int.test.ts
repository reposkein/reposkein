import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Neo4jGraphStore } from "../src/store/Neo4jGraphStore.js";

const gated = process.env.NEO4J_PASSWORD ? describe : describe.skip;

gated("Neo4jGraphStore (integration)", () => {
  let store: Neo4jGraphStore;
  beforeAll(() => {
    store = Neo4jGraphStore.fromEnv();
  });
  afterAll(async () => {
    await store.close();
  });

  it("runs a read query and returns plain objects", async () => {
    const rows = await store.runRead("RETURN 1 AS n");
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("rejects writes at the driver (READ mode is the boundary)", async () => {
    await expect(store.runRead("CREATE (x:McpSpike) RETURN x")).rejects.toThrow();
  });
});
