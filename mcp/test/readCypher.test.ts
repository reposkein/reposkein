import { describe, it, expect, vi } from "vitest";
import { makeReadCypher } from "../src/tools/readCypher.js";
import type { GraphStore } from "../src/store/GraphStore.js";

function mockStore(rows: Record<string, unknown>[]): GraphStore {
  return {
    runRead: vi.fn(async () => rows),
    close: vi.fn(async () => {}),
  };
}

describe("makeReadCypher", () => {
  it("returns rows + truncated for a valid read", async () => {
    const handler = makeReadCypher(mockStore([{ a: 1 }]), "repo123");
    const res = await handler({ query: "MATCH (n) RETURN n" });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.rows).toEqual([{ a: 1 }]);
    expect(payload.truncated).toBe(false);
    expect(res.isError).toBeFalsy();
  });

  it("blocks writes via the guard before touching the store", async () => {
    const store = mockStore([]);
    const handler = makeReadCypher(store, "repo123");
    const res = await handler({ query: "MATCH (n) DELETE n" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/read-only/i);
    expect(store.runRead).not.toHaveBeenCalled();
  });

  it("passes repo_id as a param", async () => {
    const store = mockStore([]);
    const handler = makeReadCypher(store, "repo123");
    await handler({ query: "MATCH (n) RETURN n" });
    expect(store.runRead).toHaveBeenCalledWith(
      "MATCH (n) RETURN n",
      expect.objectContaining({ repo_id: "repo123" }),
      expect.anything()
    );
  });

  it("returns DB errors verbatim as isError", async () => {
    const store: GraphStore = {
      runRead: vi.fn(async () => {
        throw new Error("Neo.ClientError.Statement.SyntaxError: bad");
      }),
      close: vi.fn(async () => {}),
    };
    const handler = makeReadCypher(store, "repo123");
    const res = await handler({ query: "MATCH (n) RETURN n" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/SyntaxError/);
  });
});
