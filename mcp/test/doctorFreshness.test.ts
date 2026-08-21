import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksCheck, graphStaleCheck } from "../src/cli/doctorFreshness.js";
import { writeIndexedAtMarker, indexedAtPath } from "../src/store/indexedAt.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-freshness-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function git(args: string[], cwd = dir): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(cwd = dir): void {
  git(["init", "-q"], cwd);
  git(["config", "user.email", "test@example.com"], cwd);
  git(["config", "user.name", "test"], cwd);
}

function headSha(cwd = dir): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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

describe("graphStaleCheck (content-based: recorded indexed-at SHA vs. HEAD)", () => {
  it("fails (never-indexed flavor) when nodes.jsonl is entirely missing", () => {
    const c = graphStaleCheck(dir);
    expect(c.id).toBe("graph_stale");
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/never indexed/);
  });

  it("fails when nodes.jsonl exists but no indexed-at SHA was ever recorded", () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    const c = graphStaleCheck(dir);
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/no recorded indexed-at commit/);
    expect(c.fix).toMatch(/reposkein-mcp index/);
  });

  it("skips cleanly (ok) when there's no git HEAD to compare against, even with a recorded SHA", () => {
    // No git repo at all: writeIndexedAtMarker itself is a no-op (best-effort),
    // so simulate a stray/manually-copied marker file instead.
    mkdirSync(join(dir, ".reposkein", "local"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "local", "indexed-at"), "deadbeef\n");
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    const c = graphStaleCheck(dir);
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/no git HEAD/);
  });

  it("passes when the recorded SHA matches current HEAD", () => {
    initRepo();
    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "add a.py"]);
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    writeIndexedAtMarker(dir);
    const c = graphStaleCheck(dir);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain(headSha().slice(0, 7));
  });

  it("fails when the recorded SHA no longer matches HEAD (commits landed since the last index)", () => {
    initRepo();
    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit A"]);
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    writeIndexedAtMarker(dir); // records commit A
    const shaA = headSha();

    writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit B"]);
    const shaB = headSha();
    expect(shaB).not.toBe(shaA);

    const c = graphStaleCheck(dir);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(shaA.slice(0, 7));
    expect(c.detail).toContain(shaB.slice(0, 7));
    expect(c.fix).toMatch(/reposkein-mcp index/);
  });

  it("reviewer repro: index at commit A, advance to commit B, clone fresh -> doctor --ci FAILS " +
     "(the mtime heuristic this replaced could not catch this: a fresh checkout stamps every " +
     "file with 'now', which is always >= any past commit's timestamp)", () => {
    // Origin repo: commit A, indexed at A.
    initRepo();
    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit A"]);
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    writeIndexedAtMarker(dir);
    const shaA = headSha();

    // Advance to commit B — a real code change after the last index.
    writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit B"]);
    const shaB = headSha();
    expect(shaB).not.toBe(shaA);

    // A REAL `git clone` of the origin. .reposkein/ was never committed (it's
    // gitignored scratch/derived output), so the clone starts with none of it —
    // this is the realistic shape of "a teammate/CI clones this repo".
    const cloneDir = mkdtempSync(join(tmpdir(), "rs-freshness-clone-"));
    try {
      execFileSync("git", ["clone", "-q", dir, cloneDir]);
      expect(headSha(cloneDir)).toBe(shaB);

      // Simulate the realistic "stale index carried forward" failure mode
      // (a CI cache restoring a prior run's .reposkein/, a copied artifact,
      // etc.): the fresh clone ends up with nodes.jsonl + the OLD indexed-at
      // marker (from commit A) written into it — necessarily with a mtime of
      // "now", i.e. well after commit B. This is exactly the case where the
      // old mtime-based check would have read as fresh (mtime "now" >=
      // lastCommitMs) despite the graph being genuinely stale.
      mkdirSync(join(cloneDir, ".reposkein", "local"), { recursive: true });
      writeFileSync(join(cloneDir, ".reposkein", "nodes.jsonl"), "{}\n");
      writeFileSync(join(cloneDir, ".reposkein", "local", "indexed-at"), shaA + "\n");

      const c = graphStaleCheck(cloneDir);
      expect(c.ok).toBe(false);
      expect(c.detail).toContain(shaA.slice(0, 7));
      expect(c.detail).toContain(shaB.slice(0, 7));
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("reviewer repro (simplest form): a bare fresh clone with no .reposkein/ at all also fails", () => {
    initRepo();
    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit A"]);
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    writeIndexedAtMarker(dir);

    writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit B"]);

    const cloneDir = mkdtempSync(join(tmpdir(), "rs-freshness-clone-"));
    try {
      execFileSync("git", ["clone", "-q", dir, cloneDir]);
      const c = graphStaleCheck(cloneDir);
      expect(c.ok).toBe(false);
      expect(c.detail).toMatch(/never indexed/);
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it("closes the false-fail loop: a hook-maintained marker (no mcp-side index call at all) " +
     "stays fresh across multiple commits", () => {
    // Simulates the real hook workflow end-to-end at the doctor layer:
    // pre-commit indexes the about-to-be-committed tree, post-commit then
    // writes HEAD (the new commit) to the marker — modeled here by writing
    // nodes.jsonl + the marker right after each commit, exactly like the
    // Rust post-commit hook does, without ever calling the mcp-side
    // `reposkein-mcp index` / `writeIndexedAtMarker` from a *different*
    // commit's context. Before the hooks existed, this sequence would have
    // gone stale after the very first commit (pre-commit indexed, nothing
    // ever advanced the marker) — that's the false-fail loop being closed.
    initRepo();
    mkdirSync(join(dir, ".reposkein", "local"), { recursive: true });

    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit 1"]);
    // pre-commit's index run + post-commit's marker write, simulated:
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    writeFileSync(indexedAtPath(dir), headSha() + "\n");
    expect(graphStaleCheck(dir).ok).toBe(true);

    writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit 2"]);
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    writeFileSync(indexedAtPath(dir), headSha() + "\n");
    expect(graphStaleCheck(dir).ok).toBe(true);

    writeFileSync(join(dir, "a.py"), "def f():\n    return 3\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit 3"]);
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "{}\n");
    writeFileSync(indexedAtPath(dir), headSha() + "\n");
    expect(graphStaleCheck(dir).ok).toBe(true);
  });
});
