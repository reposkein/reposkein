import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoSession, describeRepo, discoverRepoPaths } from "../src/store/repoSession.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-session-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("describeRepo", () => {
  it("uses meta.json's repo_id as the name when present", () => {
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "meta.json"), JSON.stringify({ repo_id: "rs1:abc" }));
    const info = describeRepo(dir);
    expect(info).toEqual({ path: dir, repo_id: "rs1:abc", name: "rs1:abc" });
  });

  it("falls back to the directory basename when meta.json is absent", () => {
    mkdirSync(join(dir, ".reposkein"));
    const info = describeRepo(dir);
    expect(info.repo_id).toBeUndefined();
    expect(info.name).toBe(dir.split("/").pop());
  });

  it("includes cheap node/edge counts when the jsonl files exist", () => {
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"a"}\n{"id":"b"}\n');
    writeFileSync(join(dir, ".reposkein", "edges.jsonl"), '{"id":"e1"}\n');
    const info = describeRepo(dir);
    expect(info.nodes).toBe(2);
    expect(info.edges).toBe(1);
  });
});

describe("RepoSession — single-repo mode (list_repos)", () => {
  it("lists exactly the one repo found via walk-up", () => {
    mkdirSync(join(dir, ".reposkein"));
    const sub = join(dir, "src");
    mkdirSync(sub, { recursive: true });
    const session = new RepoSession({ cwd: sub, envRepoPath: undefined });
    const repos = session.list();
    expect(repos).toHaveLength(1);
    expect(repos[0]!.path).toBe(dir);
    expect(repos[0]!.selected).toBe(true);
  });

  it("lists the repo pinned by REPOSKEIN_REPO_PATH even when the cwd's own walk finds nothing nearby", () => {
    mkdirSync(join(dir, ".reposkein")); // the env-pinned repo
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "reposkein-session-unrelated-"));
    try {
      const session = new RepoSession({ cwd: unrelatedCwd, envRepoPath: dir });
      const repos = session.list();
      expect(repos).toEqual([expect.objectContaining({ path: dir, selected: true })]);
    } finally {
      rmSync(unrelatedCwd, { recursive: true, force: true });
    }
  });
});

describe("RepoSession — workspace mode (list_repos, select_repo)", () => {
  function seedTwoRepos(): { repoA: string; repoB: string } {
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    mkdirSync(join(repoA, ".reposkein"), { recursive: true });
    mkdirSync(join(repoB, ".reposkein"), { recursive: true });
    return { repoA, repoB };
  }

  it("lists all discovered candidates, none selected by default", () => {
    const { repoA, repoB } = seedTwoRepos();
    const session = new RepoSession({ cwd: dir, envRepoPath: undefined });
    const repos = session.list();
    expect(repos.map((r) => r.path)).toEqual([repoA, repoB]);
    expect(repos.every((r) => !r.selected)).toBe(true);
    expect(session.resolve()).toEqual({ repoPath: undefined, source: "none", candidates: [repoA, repoB] });
  });

  it("select_repo by path switches resolve() to that repo", () => {
    const { repoA, repoB } = seedTwoRepos();
    const session = new RepoSession({ cwd: dir, envRepoPath: undefined });
    const result = session.select(repoB);
    expect(result).toEqual({ ok: true, repo: expect.objectContaining({ path: repoB }) });
    expect(session.resolve()).toEqual({ repoPath: repoB, source: "explicit" });
    // list_repos reflects the new selection too.
    const repos = session.list();
    expect(repos.find((r) => r.path === repoA)!.selected).toBe(false);
    expect(repos.find((r) => r.path === repoB)!.selected).toBe(true);
  });

  it("select_repo by name (meta.json repo_id) also works", () => {
    const { repoA } = seedTwoRepos();
    writeFileSync(join(repoA, ".reposkein", "meta.json"), JSON.stringify({ repo_id: "my-repo-a" }));
    const session = new RepoSession({ cwd: dir, envRepoPath: undefined });
    const result = session.select("my-repo-a");
    expect(result.ok).toBe(true);
    expect(session.resolve().repoPath).toBe(repoA);
  });

  it("select_repo with an unknown value fails, naming the real candidates", () => {
    const { repoA, repoB } = seedTwoRepos();
    const session = new RepoSession({ cwd: dir, envRepoPath: undefined });
    const result = session.select("/nowhere/repo-z");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(repoA);
      expect(result.error).toContain(repoB);
      expect(result.error).toMatch(/list_repos/);
    }
  });

  it("switching selection back and forth updates resolve() each time", () => {
    const { repoA, repoB } = seedTwoRepos();
    const session = new RepoSession({ cwd: dir, envRepoPath: undefined });
    session.select(repoA);
    expect(session.resolve().repoPath).toBe(repoA);
    session.select(repoB);
    expect(session.resolve().repoPath).toBe(repoB);
    session.select(repoA);
    expect(session.resolve().repoPath).toBe(repoA);
  });
});

describe("RepoSession — precedence (select_repo > env > walk-up > walk-down)", () => {
  it("select_repo overrides REPOSKEIN_REPO_PATH once called, even to a sibling env didn't name", () => {
    const { repoA, repoB } = (() => {
      const repoA = join(dir, "repo-a");
      const repoB = join(dir, "repo-b");
      mkdirSync(join(repoA, ".reposkein"), { recursive: true });
      mkdirSync(join(repoB, ".reposkein"), { recursive: true });
      return { repoA, repoB };
    })();
    const session = new RepoSession({ cwd: dir, envRepoPath: repoA });
    // Before select_repo: env wins, as always.
    expect(session.resolve()).toEqual({ repoPath: repoA, source: "env" });
    // list_repos still surfaces every repo the workspace walk finds (repo-a
    // AND repo-b) — env only picks the *default*, it doesn't hide siblings,
    // which is what makes select_repo useful here in the first place.
    expect(session.list().map((r) => r.path)).toEqual([repoA, repoB]);
    // select_repo can switch to that sibling despite the env pin.
    const result = session.select(repoB);
    expect(result.ok).toBe(true);
    expect(session.resolve()).toEqual({ repoPath: repoB, source: "explicit" });
  });

  it("without select_repo, env still wins over walk-up", () => {
    mkdirSync(join(dir, ".reposkein"));
    const envPath = join(dir, "elsewhere");
    mkdirSync(envPath, { recursive: true });
    const session = new RepoSession({ cwd: dir, envRepoPath: envPath });
    expect(session.resolve()).toEqual({ repoPath: envPath, source: "env" });
  });
});

describe("discoverRepoPaths", () => {
  it("is a pure filesystem walk (walk-up, else walk-down) regardless of env", () => {
    mkdirSync(join(dir, ".reposkein"));
    expect(discoverRepoPaths({ cwd: dir })).toEqual([dir]);
    expect(discoverRepoPaths({ cwd: dir, envRepoPath: "/some/other/env/path" })).toEqual(
      ["/some/other/env/path", dir].sort()
    );
  });

  it("unions in the env-pinned repo when the walk already found it (no duplicate)", () => {
    mkdirSync(join(dir, ".reposkein"));
    expect(discoverRepoPaths({ cwd: dir, envRepoPath: dir })).toEqual([dir]);
  });
});
