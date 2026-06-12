import { describe, it, expect, vi } from "vitest";
import { federationIds } from "../src/store/federation.js";
import type { GraphStore } from "../src/store/GraphStore.js";

function store(rows: Record<string, unknown>[]): GraphStore {
  return {
    runRead: vi.fn(async () => rows),
    runWrite: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
}

describe("federationIds", () => {
  it("returns the active repo plus federated ids, sorted, deduped", async () => {
    const ids = await federationIds(store([{ id: "childB" }, { id: "childA" }, { id: "childA" }]), "rootZ");
    expect(ids).toEqual(["childA", "childB", "rootZ"]);
  });

  it("returns just the active repo when there are no children", async () => {
    expect(await federationIds(store([]), "solo")).toEqual(["solo"]);
  });
});
