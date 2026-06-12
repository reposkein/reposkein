import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRepoId } from "../src/store/repoId.js";

describe("resolveRepoId", () => {
  it("returns the env override when provided, ignoring meta.json", () => {
    const result = resolveRepoId("/some/path", "env-override-id");
    expect(result).toBe("env-override-id");
  });

  it("reads repo_id from .reposkein/meta.json when no env override", () => {
    const dir = mkdtempSync(join(tmpdir(), "reposkein-test-"));
    try {
      mkdirSync(join(dir, ".reposkein"));
      writeFileSync(
        join(dir, ".reposkein", "meta.json"),
        JSON.stringify({ repo_id: "meta-repo-id", id_scheme: "rs1" })
      );
      const result = resolveRepoId(dir, undefined);
      expect(result).toBe("meta-repo-id");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns undefined when repoPath is undefined and no env override", () => {
    const result = resolveRepoId(undefined, undefined);
    expect(result).toBeUndefined();
  });

  it("returns undefined when meta.json is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "reposkein-test-"));
    try {
      const result = resolveRepoId(dir, undefined);
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns undefined when meta.json has no string repo_id", () => {
    const dir = mkdtempSync(join(tmpdir(), "reposkein-test-"));
    try {
      mkdirSync(join(dir, ".reposkein"));
      writeFileSync(join(dir, ".reposkein", "meta.json"), JSON.stringify({ repo_id: 42 }));
      const result = resolveRepoId(dir, undefined);
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("env override wins over meta.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "reposkein-test-"));
    try {
      mkdirSync(join(dir, ".reposkein"));
      writeFileSync(
        join(dir, ".reposkein", "meta.json"),
        JSON.stringify({ repo_id: "meta-id" })
      );
      const result = resolveRepoId(dir, "env-wins");
      expect(result).toBe("env-wins");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
