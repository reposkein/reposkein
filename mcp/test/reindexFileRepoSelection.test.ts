import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoSession } from "../src/store/repoSession.js";
import { resolveRepoId } from "../src/store/repoId.js";
import { makeReindexFile, makeInitCpgSkeleton } from "../src/tools/indexerTools.js";

/** Regression coverage for the "wrong repo indexed" bug class: index.ts's
 *  reindex_file/init_cpg_skeleton handlers used to resolve their target repo
 *  independently (indexer/runIndexer.js's old `repoPath()`, an
 *  REPOSKEIN_REPO_PATH-or-cwd fallback baked into indexerTools.ts) instead of
 *  going through the same RepoSession every other repo-scoped tool uses —
 *  so a session that called select_repo and then reindex_file could still
 *  silently reindex a different repo. This mirrors exactly what
 *  index.ts's resolveActiveRepo() + tool handlers do: RepoSession.resolve()
 *  -> resolveRepoId -> makeReindexFile/makeInitCpgSkeleton(repoId, repoPath). */
describe("reindex_file / init_cpg_skeleton target the session-selected repo (not env/cwd)", () => {
  let ws: string;
  let repoA: string;
  let repoB: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "rs-workspace-"));
    repoA = join(ws, "repo-a");
    repoB = join(ws, "repo-b");
    mkdirSync(join(repoA, ".reposkein"), { recursive: true });
    mkdirSync(join(repoB, ".reposkein"), { recursive: true });
    writeFileSync(join(repoA, ".reposkein", "meta.json"), JSON.stringify({ repo_id: "repo-a-id" }));
    writeFileSync(join(repoB, ".reposkein", "meta.json"), JSON.stringify({ repo_id: "repo-b-id" }));
    prevEnv = process.env.REPOSKEIN_REPO_PATH;
    // Deliberately pin the env var at repo-a, NOT repo-b — proves the
    // selected repo wins and the tools never fall back to env/cwd internally.
    process.env.REPOSKEIN_REPO_PATH = repoA;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.REPOSKEIN_REPO_PATH;
    else process.env.REPOSKEIN_REPO_PATH = prevEnv;
    rmSync(ws, { recursive: true, force: true });
  });

  it("reindex_file's runner receives repo-b's path+id after select_repo, never repo-a's", async () => {
    const session = new RepoSession({ cwd: ws, envRepoPath: process.env.REPOSKEIN_REPO_PATH });
    // Before select_repo: env wins, as always — sanity check the fixture.
    expect(session.resolve().repoPath).toBe(repoA);

    const selectResult = session.select("repo-b-id");
    expect(selectResult.ok).toBe(true);

    // Exactly what index.ts's resolveActiveRepo() does.
    const resolution = session.resolve();
    expect(resolution.repoPath).toBe(repoB);
    const repoId = resolveRepoId(resolution.repoPath, process.env.REPOSKEIN_REPO_ID);
    expect(repoId).toBe("repo-b-id");

    const calls: Array<{ id: string; path: string }> = [];
    const reindex = makeReindexFile(repoId!, resolution.repoPath!, {
      run: async (id, path) => {
        calls.push({ id, path });
        return { ok: true, nodes: 0, edges: 0, files: 0, warnings: [] };
      },
    });
    await reindex({ path: "src/x.ts" });

    expect(calls).toEqual([{ id: "repo-b-id", path: repoB }]);
    expect(calls[0]!.path).not.toBe(repoA);
  });

  it("init_cpg_skeleton (no explicit args.path) defaults to repo-b after select_repo, never repo-a", async () => {
    const session = new RepoSession({ cwd: ws, envRepoPath: process.env.REPOSKEIN_REPO_PATH });
    session.select("repo-b-id");
    const resolution = session.resolve();
    const repoId = resolveRepoId(resolution.repoPath, process.env.REPOSKEIN_REPO_ID);

    const calls: Array<{ id: string; path: string }> = [];
    const init = makeInitCpgSkeleton(repoId!, resolution.repoPath!, {
      run: async (id, path) => {
        calls.push({ id, path });
        return { ok: true, nodes: 0, edges: 0, files: 0, warnings: [] };
      },
    });
    await init({});

    expect(calls).toEqual([{ id: "repo-b-id", path: repoB }]);
  });

  it("switching selection again (repo-b -> repo-a) redirects the very next reindex_file call", async () => {
    const session = new RepoSession({ cwd: ws, envRepoPath: process.env.REPOSKEIN_REPO_PATH });
    session.select("repo-b-id");

    async function reindexOnceWithCurrentSelection(): Promise<string> {
      const resolution = session.resolve();
      const repoId = resolveRepoId(resolution.repoPath, process.env.REPOSKEIN_REPO_ID);
      let targeted = "";
      const reindex = makeReindexFile(repoId!, resolution.repoPath!, {
        run: async (_id, path) => {
          targeted = path;
          return { ok: true, nodes: 0, edges: 0, files: 0, warnings: [] };
        },
      });
      await reindex({ path: "src/x.ts" });
      return targeted;
    }

    expect(await reindexOnceWithCurrentSelection()).toBe(repoB);
    session.select("repo-a-id");
    expect(await reindexOnceWithCurrentSelection()).toBe(repoA);
  });
});
