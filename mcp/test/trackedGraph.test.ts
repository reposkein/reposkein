import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackedGraphFiles, trackedGraphWarning } from "../src/store/trackedGraph.js";

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rs-tracked-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("trackedGraphFiles", () => {
  it("returns both graph files when they are committed", () => {
    git(dir, ["init", "-q"]);
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
    writeFileSync(join(dir, ".reposkein", "edges.jsonl"), '{"src":"n1"}\n');
    git(dir, ["add", ".reposkein"]);
    git(dir, ["commit", "-q", "-m", "track graph"]);
    expect(trackedGraphFiles(dir).sort()).toEqual([
      ".reposkein/edges.jsonl",
      ".reposkein/nodes.jsonl",
    ]);
  });

  it("returns [] when the files exist but are untracked", () => {
    git(dir, ["init", "-q"]);
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
    expect(trackedGraphFiles(dir)).toEqual([]);
  });

  it("returns [] outside a git repository", () => {
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
    expect(trackedGraphFiles(dir)).toEqual([]);
  });
});

describe("trackedGraphWarning", () => {
  it("names the fix command and the pathspec escape hatch when tracked", () => {
    git(dir, ["init", "-q"]);
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
    git(dir, ["add", ".reposkein"]);
    git(dir, ["commit", "-q", "-m", "track graph"]);
    const w = trackedGraphWarning(dir);
    expect(w).toContain("reposkein-mcp migrate");
    expect(w).toContain(":(exclude).reposkein");
  });

  it("is undefined when nothing is tracked", () => {
    git(dir, ["init", "-q"]);
    expect(trackedGraphWarning(dir)).toBeUndefined();
  });
});
