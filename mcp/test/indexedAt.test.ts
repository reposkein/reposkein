import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexedAtPath, writeIndexedAtMarker, readIndexedAtSha } from "../src/store/indexedAt.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-indexedat-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

describe("indexedAtPath", () => {
  it("points at .reposkein/local/indexed-at", () => {
    expect(indexedAtPath(dir)).toBe(join(dir, ".reposkein", "local", "indexed-at"));
  });
});

describe("readIndexedAtSha", () => {
  it("returns null when never recorded", () => {
    expect(readIndexedAtSha(dir)).toBeNull();
  });

  it("returns null for a blank file", () => {
    mkdirSync(join(dir, ".reposkein", "local"), { recursive: true });
    writeFileSync(indexedAtPath(dir), "   \n");
    expect(readIndexedAtSha(dir)).toBeNull();
  });

  it("reads a recorded SHA, trimmed", () => {
    mkdirSync(join(dir, ".reposkein", "local"), { recursive: true });
    writeFileSync(indexedAtPath(dir), "abc123\n");
    expect(readIndexedAtSha(dir)).toBe("abc123");
  });
});

describe("writeIndexedAtMarker", () => {
  it("records the current git HEAD", () => {
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.py"), "x = 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "init"]);
    const sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    writeIndexedAtMarker(dir);
    expect(readIndexedAtSha(dir)).toBe(sha);
    // Written under .reposkein/local/ — the gitignored per-machine scratch dir.
    expect(existsSync(indexedAtPath(dir))).toBe(true);
    expect(readFileSync(indexedAtPath(dir), "utf8")).toBe(sha + "\n");
  });

  it("overwrites the previous SHA on a later call", () => {
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "a.py"), "x = 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit A"]);
    writeIndexedAtMarker(dir);
    const shaA = readIndexedAtSha(dir);

    writeFileSync(join(dir, "a.py"), "x = 2\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "commit B"]);
    writeIndexedAtMarker(dir);
    const shaB = readIndexedAtSha(dir);

    expect(shaB).not.toBe(shaA);
  });

  it("is a silent no-op outside a git repo (no marker written, doesn't throw)", () => {
    expect(() => writeIndexedAtMarker(dir)).not.toThrow();
    expect(readIndexedAtSha(dir)).toBeNull();
  });
});
