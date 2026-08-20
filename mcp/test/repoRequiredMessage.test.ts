import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repoRequiredMessage, repoUnindexedMessage } from "../src/index.js";

describe("repoRequiredMessage", () => {
  it("points at list_repos and select_repo (not just the env var) on ambiguity", () => {
    const msg = repoRequiredMessage({
      repoPath: undefined,
      source: "none",
      candidates: ["/ws/repo-a", "/ws/repo-b"],
    });
    expect(msg).toContain("/ws/repo-a");
    expect(msg).toContain("/ws/repo-b");
    expect(msg).toMatch(/list_repos/);
    expect(msg).toMatch(/select_repo/);
  });

  it("mentions list_repos as a diagnostic when nothing resolved at all", () => {
    const msg = repoRequiredMessage({ repoPath: undefined, source: "none" });
    expect(msg).toMatch(/list_repos/);
    expect(msg).toMatch(/reposkein-mcp init/);
  });
});

describe("repoUnindexedMessage", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reposkein-unindexed-msg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("when .reposkein/ WAS found but has no meta.json, names the path and the index command (not the generic 'no repo found' message)", () => {
    mkdirSync(join(dir, ".reposkein"));
    const msg = repoUnindexedMessage(dir);
    expect(msg).toContain(dir);
    expect(msg).toMatch(/reposkein-mcp index/);
    expect(msg).not.toMatch(/No RepoSkein repo found/);
  });

  it("when there's no .reposkein/ at all at the resolved path, says so and points at init instead of index", () => {
    // dir exists but has no .reposkein/ subdir — e.g. a stale/misconfigured
    // REPOSKEIN_REPO_PATH or select_repo target.
    const msg = repoUnindexedMessage(dir);
    expect(msg).toContain(dir);
    expect(msg).toMatch(/reposkein-mcp init/);
    expect(msg).not.toMatch(/reposkein-mcp index/);
  });
});

