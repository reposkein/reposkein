import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSession, describeRepo } from "../src/store/repoSession.js";
import { createToolLogger } from "../src/store/instrumentTool.js";
import type { SessionLogger } from "../src/store/sessionLog.js";

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rs-warn-"));
  git(dir, ["init", "-q"]);
  mkdirSync(join(dir, ".reposkein"));
  writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
  writeFileSync(join(dir, ".reposkein", "edges.jsonl"), '{"src":"n1"}\n');
  git(dir, ["add", ".reposkein"]);
  git(dir, ["commit", "-q", "-m", "track"]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stubLogger = { logAt: () => {} } as unknown as SessionLogger;

describe("describeRepo", () => {
  it("flags a tracked graph", () => {
    expect(describeRepo(dir).graph_tracked).toBe(true);
  });
  it("omits the flag when untracked", () => {
    const clean = mkdtempSync(join(tmpdir(), "rs-warn-clean-"));
    git(clean, ["init", "-q"]);
    mkdirSync(join(clean, ".reposkein"));
    writeFileSync(join(clean, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
    expect(describeRepo(clean).graph_tracked).toBeUndefined();
    rmSync(clean, { recursive: true, force: true });
  });
});

describe("RepoSession.takeTrackedGraphWarning", () => {
  it("returns the warning once, then undefined for the rest of the session", () => {
    const session = new RepoSession({ cwd: dir, envRepoPath: undefined });
    const first = session.takeTrackedGraphWarning();
    expect(first).toContain("reposkein-mcp migrate");
    expect(session.takeTrackedGraphWarning()).toBeUndefined();
  });
});

describe("withLog warning append", () => {
  it("appends the warning to the first successful tool result only", async () => {
    const session = new RepoSession({ cwd: dir, envRepoPath: undefined });
    const { withLog } = createToolLogger(session, stubLogger, (fn) => fn());
    const tool = withLog("fake_tool", async () => ({
      content: [{ type: "text", text: "{}" }],
    }));
    const r1 = await tool({});
    expect(r1.content).toHaveLength(2);
    expect((r1.content[1] as { text: string }).text).toContain("reposkein-mcp migrate");
    const r2 = await tool({});
    expect(r2.content).toHaveLength(1);
  });

  it("never appends to error results", async () => {
    const session = new RepoSession({ cwd: dir, envRepoPath: undefined });
    const { withLog } = createToolLogger(session, stubLogger, (fn) => fn());
    const tool = withLog("fake_tool", async () => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }));
    const r = await tool({});
    expect(r.content).toHaveLength(1);
  });
});
