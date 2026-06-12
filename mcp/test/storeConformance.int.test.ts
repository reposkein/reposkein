import { describe, beforeAll, afterAll, it } from "vitest";
import { Neo4jGraphStore } from "../src/store/Neo4jGraphStore.js";
import { setupFixture } from "./fixture.js";
import { assertConformance } from "./storeConformance.js";

const gated = process.env.NEO4J_PASSWORD ? describe : describe.skip;

gated("store conformance (Neo4j parity)", () => {
  let store: Neo4jGraphStore;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupFixture();
    store = Neo4jGraphStore.fromEnv();
  });
  afterAll(async () => {
    await store.close();
    await cleanup();
  });

  it("Neo4jGraphStore satisfies the same conformance contract as JsonlGraphStore", async () => {
    await assertConformance(store);
  });
});
