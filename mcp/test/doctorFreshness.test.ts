import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksCheck, graphStaleCheck } from "../src/cli/doctorFreshness.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-freshness-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function git(args: string[], cwd = dir): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): void {
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
}

describe("hooksCheck", () => {
  it("fails when .git/hooks/pre-commit is absent", () => {
    const c = hooksCheck(dir);
    expect(c.id).toBe("hooks_installed");
    expect(c.ok).toBe(false);
    expect(c.critical).toBe(false);
    expect(c.detail).toMatch(/no \.git\/hooks\/pre-commit/);
  });

  it("fails when pre-commit exists but wasn't installed by RepoSkein (no marker)", () => {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hi\n");
    const c = hooksCheck(dir);
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/not installed by RepoSkein/);
  });

  it("passes when the reposkein-managed marker is present", () => {
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\n# reposkein-managed\nexit 0\n");
    const c = hooksCheck(dir);
    expect(c.ok).toBe(true);
  });
});

describe("graphStaleCheck", () => {
  it("fails (not stale-flavored) when nodes.jsonl is entirely missing", () => {
    const c = graphStaleCheck(dir);
    expect(c.id).toBe("graph_stale");
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/never indexed/);
  });

  it("skips cleanly (ok) when there's no git history to compare against", () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    const c = graphStaleCheck(dir);
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/no git history/);
  });

  it("flags nodes.jsonl older than the last relevant commit as stale", () => {
    initRepo();
    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "add a.py"]);
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    const nodesPath = join(dir, ".reposkein", "nodes.jsonl");
    writeFileSync(nodesPath, "{}\n");
    // Backdate the graph file well before the commit above.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(nodesPath, old, old);
    const c = graphStaleCheck(dir);
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/older than the last commit/);
    expect(c.fix).toMatch(/reposkein-mcp index/);
  });

  it("passes when nodes.jsonl is newer than the last relevant commit", () => {
    initRepo();
    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "add a.py"]);
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n"); // written just now
    const c = graphStaleCheck(dir);
    expect(c.ok).toBe(true);
  });

  it("a commit touching only .reposkein/ (e.g. a summary) doesn't mark the graph stale", () => {
    initRepo();
    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "add a.py"]);
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    const c1 = graphStaleCheck(dir);
    expect(c1.ok).toBe(true);
    // A later commit that only touches .reposkein/ shouldn't retroactively
    // make the (unchanged, still-fresh) graph read as stale.
    writeFileSync(join(dir, ".reposkein", "summaries.jsonl"), "{}\n");
    git(["add", ".reposkein/summaries.jsonl"]);
    git(["commit", "-qm", "agent summary"]);
    const c2 = graphStaleCheck(dir);
    expect(c2.ok).toBe(true);
  });
});
