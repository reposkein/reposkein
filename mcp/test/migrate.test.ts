import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrate } from "../src/cli/migrate.js";

// Same hermetic fake-indexer pattern as doctor.test.ts: no network, no real
// binary. `migrate` shells out for `init --hooks` and `index`; the fake
// answers everything with exit 0.
let fixtureDir: string;
let savedIndexerBin: string | undefined;
beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "rs-migrate-fixture-"));
  const fakeBin = join(fixtureDir, "reposkein-indexer");
  writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("ok");\nprocess.exit(0);\n');
  chmodSync(fakeBin, 0o755);
  savedIndexerBin = process.env.REPOSKEIN_INDEXER_BIN;
  process.env.REPOSKEIN_INDEXER_BIN = fakeBin;
});
afterAll(() => {
  if (savedIndexerBin === undefined) delete process.env.REPOSKEIN_INDEXER_BIN;
  else process.env.REPOSKEIN_INDEXER_BIN = savedIndexerBin;
  rmSync(fixtureDir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function trackedFixture(dir: string): void {
  git(dir, ["init", "-q"]);
  mkdirSync(join(dir, ".reposkein"));
  writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
  writeFileSync(join(dir, ".reposkein", "edges.jsonl"), '{"src":"n1"}\n');
  git(dir, ["add", ".reposkein"]);
  git(dir, ["commit", "-q", "-m", "track graph"]);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-migrate-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runMigrate", () => {
  it("untracks the graph (staged deletion, files kept on disk)", async () => {
    trackedFixture(dir);
    expect(await runMigrate(dir)).toBe(0);
    expect(git(dir, ["ls-files", ".reposkein"]).trim()).toBe("");
    const status = git(dir, ["status", "--porcelain"]);
    expect(status).toContain("D  .reposkein/nodes.jsonl");
    expect(status).toContain("D  .reposkein/edges.jsonl");
    expect(existsSync(join(dir, ".reposkein", "nodes.jsonl"))).toBe(true);
  });

  it("is idempotent — second run exits 0 with nothing to untrack", async () => {
    trackedFixture(dir);
    await runMigrate(dir);
    expect(await runMigrate(dir)).toBe(0);
  });

  it("no-ops gracefully outside a git work tree", async () => {
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
    expect(await runMigrate(dir)).toBe(0);
  });

  it("--dry-run reports but mutates nothing", async () => {
    trackedFixture(dir);
    expect(await runMigrate(dir, { dryRun: true })).toBe(0);
    expect(git(dir, ["ls-files", ".reposkein"])).toContain("nodes.jsonl");
    expect(git(dir, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("warns loudly about a foreign hook that stages .reposkein", async () => {
    trackedFixture(dir);
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "pre-commit"),
      "#!/bin/sh\nreposkein-indexer index .\ngit add .reposkein/nodes.jsonl .reposkein/edges.jsonl || true\n"
    );
    chmodSync(join(hooksDir, "pre-commit"), 0o755);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
    try {
      await runMigrate(dir);
    } finally {
      console.error = orig;
    }
    expect(errs.join("\n")).toContain("not managed by RepoSkein");
    expect(errs.join("\n")).toContain("git add");
  });
});
