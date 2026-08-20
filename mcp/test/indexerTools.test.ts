import { describe, it, expect, vi } from "vitest";
import { makeInitCpgSkeleton, makeReindexFile } from "../src/tools/indexerTools.js";

describe("indexer tools", () => {
  it("init returns stats on success", async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      nodes: 10,
      edges: 8,
      files: 3,
      warnings: [] as string[],
    }));
    const init = makeInitCpgSkeleton("repo1", "/tmp/does-not-matter", { run });
    const res = await init({});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.nodes).toBe(10);
    expect(payload.edges).toBe(8);
    expect(payload.files).toBe(3);
    expect(payload.warnings).toEqual([]);
    expect(typeof payload.duration_ms).toBe("number");
    expect(res.isError).toBeFalsy();
  });

  it("init returns warnings from indexer", async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      nodes: 5,
      edges: 2,
      files: 1,
      warnings: ["parse error in foo.py"],
    }));
    const init = makeInitCpgSkeleton("repo1", "/tmp/does-not-matter", { run });
    const res = await init({});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.warnings).toEqual(["parse error in foo.py"]);
  });

  it("init defaults to the caller-supplied repoPath when args.path is omitted", async () => {
    const run = vi.fn(async (_id: string, path: string) => ({
      ok: true as const,
      nodes: 1,
      edges: 0,
      files: 1,
      warnings: [] as string[],
    }));
    const init = makeInitCpgSkeleton("repo1", "/resolved/active/repo", { run });
    await init({});
    expect(run).toHaveBeenCalledWith("repo1", "/resolved/active/repo");
  });

  it("init passes an explicit path arg to runner, overriding repoPath", async () => {
    const run = vi.fn(async (_id: string, path: string) => ({
      ok: true as const,
      nodes: 1,
      edges: 0,
      files: 1,
      warnings: [] as string[],
    }));
    const init = makeInitCpgSkeleton("repo1", "/resolved/active/repo", { run });
    await init({ path: "/custom/path" });
    expect(run).toHaveBeenCalledWith("repo1", "/custom/path");
  });

  it("init surfaces indexer failure as isError", async () => {
    const run = vi.fn(async () => ({ ok: false as const, error: "indexer exited 1: boom" }));
    const init = makeInitCpgSkeleton("repo1", "/tmp/does-not-matter", { run });
    const res = await init({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/boom/);
  });

  it("reindex_file requires a path", async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      nodes: 1,
      edges: 0,
      files: 1,
      warnings: [] as string[],
    }));
    const reindex = makeReindexFile("repo1", "/resolved/active/repo", { run });
    const res = await reindex({} as { path: string });
    expect(res.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("reindex_file targets the caller-supplied repoPath (not env/cwd)", async () => {
    const run = vi.fn(async () => ({
      ok: true as const,
      nodes: 5,
      edges: 3,
      files: 2,
      warnings: [] as string[],
    }));
    // A deliberately different env value — proves reindex_file never falls
    // back to REPOSKEIN_REPO_PATH internally (the old runIndexer.js
    // `repoPath()` this parameter replaced).
    const prevEnv = process.env.REPOSKEIN_REPO_PATH;
    process.env.REPOSKEIN_REPO_PATH = "/env/pinned/repo";
    try {
      const reindex = makeReindexFile("repo1", "/resolved/active/repo", { run });
      const res = await reindex({ path: "src/foo.ts" });
      const payload = JSON.parse(res.content[0].text);
      expect(payload.ok).toBe(true);
      expect(payload.reindexed).toBe("src/foo.ts");
      expect(payload.files).toBe(2);
      expect(payload.warnings).toEqual([]);
      expect(run).toHaveBeenCalledWith("repo1", "/resolved/active/repo", { verb: "reindex", file: "src/foo.ts" });
    } finally {
      if (prevEnv === undefined) delete process.env.REPOSKEIN_REPO_PATH;
      else process.env.REPOSKEIN_REPO_PATH = prevEnv;
    }
  });
});
