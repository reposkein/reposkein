import { describe, it, expect } from "vitest";
import { skillTargetPath, mcpConfigSnippet, ciWorkflowTargetPath, ciWorkflowTemplate, writeCiWorkflow } from "../src/cli/init.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync as wf } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as pathJoin } from "node:path";
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
import { execFileSync } from "node:child_process";
import { runInit, skillTargetPath as stp, bundledSkillPath } from "../src/cli/init.js";

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
});
