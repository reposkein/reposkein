import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { skillTargetPath, mcpConfigSnippet, ciWorkflowTargetPath, ciWorkflowTemplate, writeCiWorkflow, detectJoinMode, runInit, ensureLocalConfigGitignored } from "../src/cli/init.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync as wf, readdirSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { execFileSync } from "node:child_process";
import type { Exec, ExecResult } from "../src/cli/agentAdapters.js";
// Re-exported under distinct names below purely so the second describe block
// (the pre-existing gated `runInit` smoke test) can keep its own reads.

describe("init helpers", () => {
  it("skillTargetPath points at .claude/skills/reposkein-graph-rag/SKILL.md", () => {
    expect(skillTargetPath("/repo")).toBe(
      "/repo/.claude/skills/reposkein-graph-rag/SKILL.md"
    );
  });
  it("mcpConfigSnippet includes the server command + repo path", () => {
    const snip = JSON.parse(mcpConfigSnippet("/repo"));
    expect(snip.mcpServers.reposkein.command).toBe("reposkein-mcp");
    expect(snip.mcpServers.reposkein.env.REPOSKEIN_REPO_PATH).toBe("/repo");
  });
});

describe("ensureLocalConfigGitignored", () => {
  it("creates .gitignore with .mcp.json, opencode.json and .cursor/mcp.json when absent", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-gitignore-"));
    try {
      ensureLocalConfigGitignored(dir);
      const gitignore = readFileSync(pathJoin(dir, ".gitignore"), "utf8");
      expect(gitignore).toContain(".mcp.json");
      expect(gitignore).toContain("opencode.json");
      expect(gitignore).toContain(".cursor/mcp.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends only the missing entries to an existing .gitignore, preserving its content", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-gitignore-"));
    try {
      wf(pathJoin(dir, ".gitignore"), "node_modules\n.mcp.json\n");
      ensureLocalConfigGitignored(dir);
      const gitignore = readFileSync(pathJoin(dir, ".gitignore"), "utf8");
      expect(gitignore).toContain("node_modules");
      expect(gitignore).toContain("opencode.json");
      expect(gitignore).toContain(".cursor/mcp.json");
      // Only one .mcp.json line (already present before the call).
      expect(gitignore.split("\n").filter((l) => l.trim() === ".mcp.json").length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent — a second call adds nothing new", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-gitignore-"));
    try {
      ensureLocalConfigGitignored(dir);
      const after1 = readFileSync(pathJoin(dir, ".gitignore"), "utf8");
      ensureLocalConfigGitignored(dir);
      const after2 = readFileSync(pathJoin(dir, ".gitignore"), "utf8");
      expect(after2).toBe(after1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

const noCliExec: Exec = () => ({ status: 1, stdout: "", stderr: "not found" });

describe("detectJoinMode", () => {
  it("false when .reposkein/meta.json doesn't exist", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-join-"));
    try {
      expect(detectJoinMode(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false when meta.json exists on disk but is not yet committed (first-time setup)", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-join-"));
    try {
      git(["init", "-q"], dir);
      mkdirSync(pathJoin(dir, ".reposkein"));
      wf(pathJoin(dir, ".reposkein", "meta.json"), '{"repo_id":"abc"}');
      expect(detectJoinMode(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true when meta.json is committed (a real join)", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-join-"));
    try {
      git(["init", "-q"], dir);
      git(["config", "user.email", "t@example.com"], dir);
      git(["config", "user.name", "t"], dir);
      mkdirSync(pathJoin(dir, ".reposkein"));
      wf(pathJoin(dir, ".reposkein", "meta.json"), '{"repo_id":"abc"}');
      git(["add", ".reposkein/meta.json"], dir);
      git(["commit", "-qm", "add reposkein config"], dir);
      expect(detectJoinMode(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false outside a git repo entirely (no crash)", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-join-"));
    try {
      mkdirSync(pathJoin(dir, ".reposkein"));
      wf(pathJoin(dir, ".reposkein", "meta.json"), '{"repo_id":"abc"}');
      expect(detectJoinMode(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runInit — unsupported platform continues instead of failing", () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const origArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  const savedBin = process.env.REPOSKEIN_INDEXER_BIN;

  function forcePlatform(platform: string, arch: string): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    Object.defineProperty(process, "arch", { value: arch, configurable: true });
  }
  function restorePlatform(): void {
    Object.defineProperty(process, "platform", origPlatform);
    Object.defineProperty(process, "arch", origArch);
    if (savedBin === undefined) delete process.env.REPOSKEIN_INDEXER_BIN;
    else process.env.REPOSKEIN_INDEXER_BIN = savedBin;
  }

  it("returns 0, skips hooks/index, and still writes agent config in join mode (darwin-x64)", async () => {
    delete process.env.REPOSKEIN_INDEXER_BIN;
    forcePlatform("darwin", "x64");
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-init-unsup-"));
    try {
      const code = await runInit(dir, {
        join: true,
        agents: ["claude"],
        agentWriteOpts: { exec: noCliExec },
      });
      expect(code).toBe(0);
      expect(existsSync(pathJoin(dir, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(existsSync(pathJoin(dir, ".reposkein", "nodes.jsonl"))).toBe(false);
      expect(existsSync(pathJoin(dir, ".mcp.json"))).toBe(true);
      const doc = JSON.parse(readFileSync(pathJoin(dir, ".mcp.json"), "utf8"));
      expect(doc.mcpServers.reposkein.command).toBe("reposkein-mcp");
    } finally {
      restorePlatform();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 0 on win32-arm64 too", async () => {
    delete process.env.REPOSKEIN_INDEXER_BIN;
    forcePlatform("win32", "arm64");
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-init-unsup-"));
    try {
      const code = await runInit(dir, { join: true, agents: ["claude"], agentWriteOpts: { exec: noCliExec } });
      expect(code).toBe(0);
    } finally {
      restorePlatform();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runInit — join mode agent config + dry-run + backup", () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const origArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  const savedBin = process.env.REPOSKEIN_INDEXER_BIN;

  beforeEach(() => {
    delete process.env.REPOSKEIN_INDEXER_BIN;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    Object.defineProperty(process, "arch", { value: "x64", configurable: true }); // unsupported → no bin needed
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", origPlatform);
    Object.defineProperty(process, "arch", origArch);
    if (savedBin === undefined) delete process.env.REPOSKEIN_INDEXER_BIN;
    else process.env.REPOSKEIN_INDEXER_BIN = savedBin;
  });

  it("--dry-run plans a write without touching disk, then a real run creates it", async () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-init-dry-"));
    try {
      const dry = await runInit(dir, { join: true, agents: ["claude"], dryRun: true, agentWriteOpts: { exec: noCliExec } });
      expect(dry).toBe(0);
      expect(existsSync(pathJoin(dir, ".mcp.json"))).toBe(false);
      const real = await runInit(dir, { join: true, agents: ["claude"], agentWriteOpts: { exec: noCliExec } });
      expect(real).toBe(0);
      expect(existsSync(pathJoin(dir, ".mcp.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent end-to-end: a second real run reports the file as already up to date (no duplicate/second .bak)", async () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-init-idem-"));
    try {
      await runInit(dir, { join: true, agents: ["claude", "opencode"], agentWriteOpts: { exec: noCliExec } });
      const mcpAfterFirst = readFileSync(pathJoin(dir, ".mcp.json"), "utf8");
      await runInit(dir, { join: true, agents: ["claude", "opencode"], agentWriteOpts: { exec: noCliExec } });
      expect(readFileSync(pathJoin(dir, ".mcp.json"), "utf8")).toBe(mcpAfterFirst);
      const backups = readdirSync(dir).filter((f: string) => f.endsWith(".bak"));
      expect(backups).toEqual([]); // nothing changed on re-run, so nothing was backed up
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("init --ci (writeCiWorkflow)", () => {
  it("ciWorkflowTargetPath points at .github/workflows/reposkein-pages.yml", () => {
    expect(ciWorkflowTargetPath("/repo")).toBe("/repo/.github/workflows/reposkein-pages.yml");
  });

  it("ciWorkflowTemplate calls the reusable publish workflow + warns Pages is public", () => {
    const yml = ciWorkflowTemplate();
    expect(yml).toContain("uses: reposkein/reposkein/.github/workflows/publish-pages.yml@main");
    expect(yml).toMatch(/public/i);
    expect(yml).toContain("pages: write");
    expect(yml).toContain("id-token: write");
  });

  it("writes the workflow file into a fresh repo", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-ci-"));
    try {
      const result = writeCiWorkflow(dir);
      expect(result.written).toBe(true);
      expect(existsSync(ciWorkflowTargetPath(dir))).toBe(true);
      expect(readFileSync(ciWorkflowTargetPath(dir), "utf8")).toContain("publish-pages.yml@main");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not clobber an existing workflow file", () => {
    const dir = mkdtempSync(pathJoin(osTmpdir(), "rs-ci-"));
    try {
      mkdirSync(pathJoin(dir, ".github", "workflows"), { recursive: true });
      wf(ciWorkflowTargetPath(dir), "# hand-edited\n");
      const result = writeCiWorkflow(dir);
      expect(result.written).toBe(false);
      expect(readFileSync(ciWorkflowTargetPath(dir), "utf8")).toBe("# hand-edited\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe as d2, it as it2, expect as e2, beforeAll, afterAll } from "vitest";
import { skillTargetPath as stp, bundledSkillPath } from "../src/cli/init.js";

const gated = process.env.REPOSKEIN_INDEXER_BIN ? d2 : d2.skip;

gated("reposkein-mcp init (smoke)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(pathJoin(osTmpdir(), "rs-init-"));
    execFileSync("git", ["init"], { cwd: dir });
    // Ensure a bundled skill exists for the copy step (dev: build + bundle may
    // not have run in this test process — copy the repo skill in if needed).
    if (!existsSync(bundledSkillPath())) {
      // dist/SKILL.md should exist after `npm run build && bundle-skill`; if not,
      // the init test still asserts hooks; skill copy is best-effort.
    }
    wf(pathJoin(dir, "a.py"), "def f():\n    return 1\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it2("installs hooks + the skill and returns 0", async () => {
    const code = await runInit(dir);
    e2(code).toBe(0);
    // Git hooks / merge driver artifacts (the indexer init writes .gitattributes).
    e2(existsSync(pathJoin(dir, ".gitattributes"))).toBe(true);
    // Skill installed (only assert if a bundled skill was present).
    if (existsSync(bundledSkillPath())) {
      e2(existsSync(stp(dir))).toBe(true);
    }
  });

  it2("real join-mode run: hooksOk gitignores the per-machine MCP config files", async () => {
    // A second init on the same dir, forced into join mode, exercises the
    // ensureLocalConfigGitignored() call on the actual hooksOk===true path
    // (not just the unit-tested function in isolation).
    const code = await runInit(dir, { join: true, agents: ["claude"], agentWriteOpts: { exec: () => ({ status: 1, stdout: "", stderr: "" }) } });
    e2(code).toBe(0);
    const gitignore = readFileSync(pathJoin(dir, ".gitignore"), "utf8");
    e2(gitignore).toContain(".mcp.json");
    e2(gitignore).toContain("opencode.json");
    e2(gitignore).toContain(".cursor/mcp.json");
  });
});
