import { describe, it, expect, vi } from "vitest";
import { makeReadCypher } from "../src/tools/readCypher.js";
import { fakeStore } from "./fakeStore.js";

describe("makeReadCypher", () => {
  it("returns rows + truncated for a valid read", async () => {
    const handler = makeReadCypher(
      fakeStore({
        runRead: vi.fn(async () => [{ a: 1 }]),
        federatedRepoIds: vi.fn(async () => []),
      }),
      "repo123"
    );
    const res = await handler({ query: "MATCH (n) RETURN n" });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.rows).toEqual([{ a: 1 }]);
    expect(payload.truncated).toBe(false);
    expect(res.isError).toBeFalsy();
  });

  it("blocks writes via the guard before touching the store", async () => {
    const runRead = vi.fn(async () => []);
    const handler = makeReadCypher(fakeStore({ runRead }), "repo123");
    const res = await handler({ query: "MATCH (n) DELETE n" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/read-only/i);
    expect(runRead).not.toHaveBeenCalled();
  });

  it("passes repo_id as a param", async () => {
    const runRead = vi.fn(async () => []);
    const handler = makeReadCypher(
      fakeStore({ runRead, federatedRepoIds: vi.fn(async () => []) }),
      "repo123"
    );
    await handler({ query: "MATCH (n) RETURN n" });
    expect(runRead).toHaveBeenCalledWith(
      "MATCH (n) RETURN n",
      expect.objectContaining({ repo_id: "repo123" }),
      expect.anything()
    );
  });

  it("returns DB errors verbatim as isError", async () => {
    const handler = makeReadCypher(
      fakeStore({
        runRead: vi.fn(async () => {
          throw new Error("Neo.ClientError.Statement.SyntaxError: bad");
        }),
        federatedRepoIds: vi.fn(async () => []),
      }),
      "repo123"
    );
    const res = await handler({ query: "MATCH (n) RETURN n" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/SyntaxError/);
  });

  it("injects singleton repo_ids by default", async () => {
    const runRead = vi.fn(async () => []);
    const handler = makeReadCypher(
      fakeStore({ runRead, federatedRepoIds: vi.fn(async () => []) }),
      "repoA"
    );
    await handler({ query: "MATCH (n) RETURN n" });
    expect(runRead).toHaveBeenCalledWith(
      "MATCH (n) RETURN n",
      expect.objectContaining({ repo_id: "repoA", repo_ids: ["repoA"] }),
      expect.anything()
    );
  });

  it("injects the federation set when federated:true", async () => {
    const runRead = vi.fn(async () => []);
    const handler = makeReadCypher(
      fakeStore({ runRead, federatedRepoIds: vi.fn(async () => ["childB"]) }),
      "repoFedTest"
    );
    await handler({ query: "MATCH (n) RETURN n", federated: true });
    const call = runRead.mock.calls[0];
    expect((call[1] as any).repo_ids.sort()).toEqual(["childB", "repoFedTest"]);
  });
});
