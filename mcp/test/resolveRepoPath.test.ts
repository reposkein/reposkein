import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRepoPath, walkUp, walkDown } from "../src/store/resolveRepoPath.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-resolve-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("walkUp", () => {
  it("finds .reposkein/ in the starting directory itself", () => {
    mkdirSync(join(dir, ".reposkein"));
    expect(walkUp(dir)).toBe(dir);
  });

  it("finds .reposkein/ in a nearer ancestor, not a farther one", () => {
    // dir/.reposkein (farther)  and  dir/a/b (start, no .reposkein of its own,
    // but should still find dir/.reposkein by walking up).
    mkdirSync(join(dir, ".reposkein"));
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(walkUp(sub)).toBe(dir);
  });

  it("prefers the nearest ancestor when multiple ancestors have .reposkein/", () => {
    mkdirSync(join(dir, ".reposkein"));
    const mid = join(dir, "mid");
    mkdirSync(join(mid, ".reposkein"), { recursive: true });
    const sub = join(mid, "sub");
    mkdirSync(sub, { recursive: true });
    expect(walkUp(sub)).toBe(mid);
  });

  it("returns undefined when no ancestor has .reposkein/", () => {
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(walkUp(sub)).toBeUndefined();
  });
});

describe("walkDown", () => {
  it("finds a single .reposkein/ among children", () => {
    const child = join(dir, "repo-a");
    mkdirSync(join(child, ".reposkein"), { recursive: true });
    expect(walkDown(dir)).toEqual([child]);
  });

  it("finds a .reposkein/ two levels deep (bounded depth)", () => {
    const grandchild = join(dir, "group", "repo-a");
    mkdirSync(join(grandchild, ".reposkein"), { recursive: true });
    expect(walkDown(dir)).toEqual([grandchild]);
  });

  it("does not find .reposkein/ three levels deep (depth bound)", () => {
    const greatGrandchild = join(dir, "a", "b", "repo-a");
    mkdirSync(join(greatGrandchild, ".reposkein"), { recursive: true });
    expect(walkDown(dir)).toEqual([]);
  });

  it("finds multiple candidates, sorted", () => {
    const repoB = join(dir, "repo-b");
    const repoA = join(dir, "repo-a");
    mkdirSync(join(repoB, ".reposkein"), { recursive: true });
    mkdirSync(join(repoA, ".reposkein"), { recursive: true });
    expect(walkDown(dir)).toEqual([repoA, repoB]);
  });

  it("skips node_modules, .git, target, dist, .worktrees, .claude", () => {
    for (const skip of ["node_modules", ".git", "target", "dist", ".worktrees", ".claude"]) {
      mkdirSync(join(dir, skip, ".reposkein"), { recursive: true });
    }
    expect(walkDown(dir)).toEqual([]);
  });

  it("does not recurse past a hit looking for nested repos", () => {
    const repo = join(dir, "repo-a");
    mkdirSync(join(repo, ".reposkein"), { recursive: true });
    mkdirSync(join(repo, "nested", ".reposkein"), { recursive: true });
    expect(walkDown(dir)).toEqual([repo]);
  });
});

describe("resolveRepoPath", () => {
  it("explicit arg wins over everything", () => {
    mkdirSync(join(dir, ".reposkein"));
    const result = resolveRepoPath({ cwd: dir, envRepoPath: "/env/path", explicit: "/explicit/path" });
    expect(result).toEqual({ repoPath: "/explicit/path", source: "explicit" });
  });

  it("env var wins over walk-up when both would resolve", () => {
    mkdirSync(join(dir, ".reposkein"));
    const result = resolveRepoPath({ cwd: dir, envRepoPath: "/env/path" });
    expect(result).toEqual({ repoPath: "/env/path", source: "env" });
  });

  it("walks up when no explicit arg or env var is set", () => {
    mkdirSync(join(dir, ".reposkein"));
    const sub = join(dir, "src", "nested");
    mkdirSync(sub, { recursive: true });
    const result = resolveRepoPath({ cwd: sub });
    expect(result).toEqual({ repoPath: dir, source: "walk-up" });
  });

  it("walks down to a single hit when no ancestor has .reposkein/", () => {
    const child = join(dir, "repo-a");
    mkdirSync(join(child, ".reposkein"), { recursive: true });
    const result = resolveRepoPath({ cwd: dir });
    expect(result).toEqual({ repoPath: child, source: "walk-down" });
  });

  it("reports ambiguity with candidate names when walk-down finds multiple hits", () => {
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    mkdirSync(join(repoA, ".reposkein"), { recursive: true });
    mkdirSync(join(repoB, ".reposkein"), { recursive: true });
    const result = resolveRepoPath({ cwd: dir });
    expect(result.repoPath).toBeUndefined();
    expect(result.source).toBe("none");
    expect(result.candidates).toEqual([repoA, repoB]);
  });

  it("resolves to undefined/none when nothing is found anywhere", () => {
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    const result = resolveRepoPath({ cwd: sub });
    expect(result).toEqual({ repoPath: undefined, source: "none" });
  });
});
