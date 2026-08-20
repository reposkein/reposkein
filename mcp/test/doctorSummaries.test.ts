import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summaryChecks } from "../src/cli/doctorSummaries.js";
import { conflictsPath, summariesDir } from "../src/store/summaryShards.js";

/** Doctor's job for the committed summaries is to catch SILENT loss: prose
 *  that exists on disk but will never reach a teammate, or a merge that
 *  discarded a record. Everything here is non-critical by design — a summary
 *  problem degrades recall, it never blocks the graph. */
describe("doctor summary checks", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-doctor-sum-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: "pipe" });

  const initGit = () => {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
  };

  const shard = (name: string, text: string) => {
    mkdirSync(summariesDir(root), { recursive: true });
    writeFileSync(join(summariesDir(root), name), text);
  };
  const legacy = (text: string) => {
    mkdirSync(join(root, ".reposkein"), { recursive: true });
    writeFileSync(join(root, ".reposkein", "summaries.jsonl"), text);
  };
  const line = (id: string, s: string) => `{"id":"${id}","semantic_summary":"${s}"}\n`;
  const find = (checks: ReturnType<typeof summaryChecks>, id: string) =>
    checks.find((c) => c.id === id);

  it("reports nothing for a repo that has never had a summary", () => {
    expect(summaryChecks(root)).toEqual([]);
  });

  it("is silent-clean for a healthy sharded repo", () => {
    initGit();
    shard("00.jsonl", line("a", "alpha"));
    const checks = summaryChecks(root);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.every((c) => !c.critical)).toBe(true);
  });

  it("detects an unsplit legacy summaries.jsonl", () => {
    initGit();
    legacy(line("a", "alpha"));
    const c = find(summaryChecks(root), "summaries_unsplit")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("summaries.jsonl");
    expect(c.fix).toContain("reposkein-indexer index");
  });

  it("still reads the legacy file's records while flagging it", () => {
    initGit();
    legacy(line("a", "alpha") + line("b", "bravo"));
    expect(find(summaryChecks(root), "summaries_unsplit")!.detail).toContain("2 record(s)");
  });

  it("detects a .gitignore rule masking the shards", () => {
    // The silent killer: a blanket `.reposkein/*` keeps authored prose out of
    // every commit with no error anywhere, and it is lost with the machine.
    initGit();
    writeFileSync(join(root, ".gitignore"), ".reposkein/\n");
    shard("00.jsonl", line("a", "alpha"));
    const c = find(summaryChecks(root), "summaries_committable")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain(".gitignore");
    expect(c.fix).toContain("!**/.reposkein/summaries/");
  });

  it("accepts the shards when a negation re-includes them", () => {
    initGit();
    writeFileSync(join(root, ".gitignore"), "**/.reposkein/*\n!**/.reposkein/summaries/\n");
    shard("00.jsonl", line("a", "alpha"));
    expect(find(summaryChecks(root), "summaries_committable")!.ok).toBe(true);
  });

  it("does not claim a masking problem outside a git repo", () => {
    shard("00.jsonl", line("a", "alpha"));
    expect(find(summaryChecks(root), "summaries_committable")!.ok).toBe(true);
  });

  it("reports a shard left with conflict markers", () => {
    initGit();
    shard("00.jsonl", `<<<<<<< HEAD\n${line("a", "ours")}=======\n${line("b", "theirs")}>>>>>>> x\n`);
    const c = find(summaryChecks(root), "summaries_readable")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("conflict-marker");
  });

  it("reports preserved divergence losers so a human reads them", () => {
    initGit();
    shard("00.jsonl", line("a", "winner"));
    mkdirSync(join(root, ".reposkein", "local"), { recursive: true });
    writeFileSync(conflictsPath(root), line("a", "loser"));
    const c = find(summaryChecks(root), "summaries_conflicts")!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("1 record(s)");
    expect(c.fix).toContain("conflicts.jsonl");
  });
});
