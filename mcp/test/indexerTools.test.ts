import { describe, it, expect, vi } from "vitest";
import { makeInitCpgSkeleton, makeReindexFile } from "../src/tools/indexerTools.js";

describe("indexer tools", () => {
  it("init returns stats on success", async () => {
    const run = vi.fn(async () => ({ ok: true as const, nodes: 10, edges: 8 }));
    const init = makeInitCpgSkeleton("repo1", { run });
    const res = await init({});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.nodes).toBe(10);
    expect(payload.edges).toBe(8);
    expect(typeof payload.duration_ms).toBe("number");
    expect(res.isError).toBeFalsy();
  });

  it("init surfaces indexer failure as isError", async () => {
    const run = vi.fn(async () => ({ ok: false as const, error: "indexer exited 1: boom" }));
    const init = makeInitCpgSkeleton("repo1", { run });
    const res = await init({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/boom/);
  });

  it("reindex_file requires a path", async () => {
    const run = vi.fn(async () => ({ ok: true as const, nodes: 1, edges: 0 }));
    const reindex = makeReindexFile("repo1", { run });
    const res = await reindex({} as { path: string });
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
