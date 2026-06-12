import { describe, it, expect, vi } from "vitest";
import { federationIds } from "../src/store/federation.js";
import { fakeStore } from "./fakeStore.js";

describe("federationIds", () => {
  it("returns the active repo plus federated ids, sorted, deduped", async () => {
    const store = fakeStore({
      federatedRepoIds: vi.fn(async () => ["childB", "childA", "childA"]),
    });
    const ids = await federationIds(store, "rootZ");
    expect(ids).toEqual(["childA", "childB", "rootZ"]);
  });

  it("returns just the active repo when there are no children", async () => {
    const store = fakeStore({ federatedRepoIds: vi.fn(async () => []) });
    expect(await federationIds(store, "solo")).toEqual(["solo"]);
  });

  it("degrades to the single repo if the store throws", async () => {
    const store = fakeStore({
      federatedRepoIds: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    // Use a fresh repo id to avoid the 30s TTL cache from earlier cases.
    expect(await federationIds(store, "degradetest")).toEqual(["degradetest"]);
  });
});
