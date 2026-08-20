import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFederatedRepos } from "../src/cli/federatedDiscovery.js";

function mkReposkein(dir: string, repoId?: string): void {
  mkdirSync(join(dir, ".reposkein"), { recursive: true });
  if (repoId) {
    writeFileSync(
      join(dir, ".reposkein", "meta.json"),
      JSON.stringify({ id_scheme: "rs1", indexer_version_min: "0.0.0", repo_id: repoId, schema_version: 1 }),
    );
  }
}

describe("discoverFederatedRepos", () => {
  it("finds a nested repo with a .reposkein/ marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-fed-"));
    try {
      mkReposkein(dir); // root itself — must be excluded
      const nested = join(dir, "packages", "widgets");
      mkdirSync(nested, { recursive: true });
      mkReposkein(nested, "widgets-repo");

      const hits = discoverFederatedRepos(dir);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.repoId).toBe("widgets-repo");
      expect(hits[0]!.rootPath).toBe("packages/widgets");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the directory name when meta.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-fed-"));
    try {
      const nested = join(dir, "sub");
      mkReposkein(nested); // no meta.json inside
      const hits = discoverFederatedRepos(dir);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.repoId).toBe("sub");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not recurse past a hit (nested-inside-nested is out of scope)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-fed-"));
    try {
      const outer = join(dir, "outer");
      mkReposkein(outer, "outer-repo");
      const inner = join(outer, "inner");
      mkReposkein(inner, "inner-repo");
      const hits = discoverFederatedRepos(dir);
      expect(hits.map((h) => h.repoId)).toEqual(["outer-repo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips node_modules/.git/target/dist", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-fed-"));
    try {
      mkReposkein(join(dir, "node_modules", "some-pkg"), "should-be-skipped");
      const hits = discoverFederatedRepos(dir);
      expect(hits).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] and never throws for a repo with no nested repos", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-fed-"));
    try {
      writeFileSync(join(dir, "a.txt"), "x");
      expect(discoverFederatedRepos(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic (sorted by rootPath)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-fed-"));
    try {
      mkReposkein(join(dir, "zeta"), "zeta-repo");
      mkReposkein(join(dir, "alpha"), "alpha-repo");
      const hits = discoverFederatedRepos(dir);
      expect(hits.map((h) => h.rootPath)).toEqual(["alpha", "zeta"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
