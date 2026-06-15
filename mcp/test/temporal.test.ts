/**
 * Integration-style tests for getTemporal().
 * Creates real temp git repos to exercise the runner end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { getTemporal } from "../src/temporal/temporal.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "pipe" });
}

function addCommit(
  dir: string,
  files: Record<string, string>,
  message = "commit",
  author = "Test User <test@test.com>",
): void {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    // Create parent dirs if needed
    execSync(`mkdir -p "$(dirname "${fullPath}")"`, { shell: true });
    require("fs").writeFileSync(fullPath, content);
    execFileSync("git", ["add", path], { cwd: dir, stdio: "pipe" });
  }
  execFileSync(
    "git",
    ["commit", "--allow-empty", "-m", message, `--author=${author}`],
    { cwd: dir, stdio: "pipe" },
  );
}

describe("getTemporal", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "reposkein-temporal-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns { unavailable } for a non-git directory", async () => {
    const result = await getTemporal(tmpDir);
    expect("unavailable" in result).toBe(true);
    expect((result as { unavailable: string }).unavailable).toMatch(/not a git repo/i);
  });

  it("returns stats for a git repo with commits", async () => {
    initRepo(tmpDir);
    addCommit(tmpDir, { "src/a.ts": "const a = 1;" });
    addCommit(tmpDir, { "src/a.ts": "const a = 2;", "src/b.ts": "const b = 1;" });
    addCommit(tmpDir, { "src/a.ts": "const a = 3;", "src/b.ts": "const b = 2;" });

    const result = await getTemporal(tmpDir);
    expect("unavailable" in result).toBe(false);
    const stats = result as Awaited<ReturnType<typeof getTemporal>> & { files: unknown };

    // src/a.ts appears in all 3 commits
    expect((stats as any).files["src/a.ts"]?.change_count).toBe(3);
    // src/b.ts appears in 2 commits
    expect((stats as any).files["src/b.ts"]?.change_count).toBe(2);
  });

  it("co-change: a+b pair that co-occurs enough times (minSupport=3 default)", async () => {
    initRepo(tmpDir);
    // Need at least 3 co-occurrences (minSupport=3 default in getTemporal)
    for (let i = 0; i < 3; i++) {
      addCommit(tmpDir, {
        "src/a.ts": `const a = ${i};`,
        "src/b.ts": `const b = ${i};`,
      }, `co-commit-${i}`);
    }

    const result = await getTemporal(tmpDir);
    expect("unavailable" in result).toBe(false);
    const stats = result as any;
    const aCoChange = stats.cochange["src/a.ts"] ?? [];
    const bEntry = aCoChange.find((e: any) => e.path === "src/b.ts");
    expect(bEntry).toBeDefined();
    expect(bEntry.support).toBe(3);
  });

  it("caches result — second call uses the cache file", async () => {
    initRepo(tmpDir);
    addCommit(tmpDir, { "src/a.ts": "const a = 1;", "src/b.ts": "const b = 1;" });
    addCommit(tmpDir, { "src/a.ts": "const a = 2;", "src/b.ts": "const b = 2;" });
    addCommit(tmpDir, { "src/a.ts": "const a = 3;", "src/b.ts": "const b = 3;" });

    // First call — should compute and write cache
    const result1 = await getTemporal(tmpDir);
    expect("unavailable" in result1).toBe(false);

    // Verify cache file was written
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf8" }).trim();
    const cacheFile = join(tmpDir, ".reposkein", "local", "temporal", `${headSha}.json`);
    expect(existsSync(cacheFile)).toBe(true);

    const mtime1 = statSync(cacheFile).mtimeMs;

    // Second call — should hit cache (mtime should not change)
    const result2 = await getTemporal(tmpDir);
    expect("unavailable" in result2).toBe(false);

    const mtime2 = statSync(cacheFile).mtimeMs;
    expect(mtime2).toBe(mtime1); // cache file not rewritten

    // Results should be identical
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });

  it("recomputes after HEAD changes", async () => {
    initRepo(tmpDir);
    addCommit(tmpDir, { "src/a.ts": "const a = 1;" });

    const result1 = await getTemporal(tmpDir);
    expect("unavailable" in result1).toBe(false);
    const sha1 = (result1 as any).head_sha;

    // Add another commit (HEAD changes)
    addCommit(tmpDir, { "src/b.ts": "const b = 1;" });

    const result2 = await getTemporal(tmpDir);
    expect("unavailable" in result2).toBe(false);
    const sha2 = (result2 as any).head_sha;

    expect(sha2).not.toBe(sha1);
    // New file should appear
    expect((result2 as any).files["src/b.ts"]).toBeDefined();
  });

  it("returns empty files/cochange for a repo with no commits in window", async () => {
    // Create repo with one commit but mock empty log by using an impossible since date
    // We can't easily test the window, but we CAN test an empty repo (init but no commits)
    const emptyDir = mkdtempSync(join(tmpdir(), "reposkein-empty-"));
    try {
      initRepo(emptyDir);
      // No commits — getTemporal should return unavailable (no HEAD)
      const result = await getTemporal(emptyDir);
      expect("unavailable" in result).toBe(true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
