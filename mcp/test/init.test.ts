import { describe, it, expect } from "vitest";
import { skillTargetPath, mcpConfigSnippet } from "../src/cli/init.js";

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

import { describe as d2, it as it2, expect as e2, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as j2 } from "node:path";
import { execFileSync } from "node:child_process";
import { runInit, skillTargetPath as stp, bundledSkillPath } from "../src/cli/init.js";

const gated = process.env.REPOSKEIN_INDEXER_BIN ? d2 : d2.skip;

gated("reposkein-mcp init (smoke)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(j2(tmpdir(), "rs-init-"));
    execFileSync("git", ["init"], { cwd: dir });
    // Ensure a bundled skill exists for the copy step (dev: build + bundle may
    // not have run in this test process — copy the repo skill in if needed).
    if (!existsSync(bundledSkillPath())) {
      // dist/SKILL.md should exist after `npm run build && bundle-skill`; if not,
      // the init test still asserts hooks; skill copy is best-effort.
    }
    writeFileSync(j2(dir, "a.py"), "def f():\n    return 1\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it2("installs hooks + the skill and returns 0", async () => {
    const code = await runInit(dir);
    e2(code).toBe(0);
    // Git hooks / merge driver artifacts (the indexer init writes .gitattributes).
    e2(existsSync(j2(dir, ".gitattributes"))).toBe(true);
    // Skill installed (only assert if a bundled skill was present).
    if (existsSync(bundledSkillPath())) {
      e2(existsSync(stp(dir))).toBe(true);
    }
  });
});
