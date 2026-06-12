import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSidecar, upsertSidecar, sidecarPath } from "../src/store/sidecar.js";

describe("sidecar", () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-sidecar-"));
    path = sidecarPath(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const rec = (id: string, hash: string) => ({
    id,
    semantic_summary: `summary ${id}`,
    summary_of_hash: hash,
    summary_model: "opus",
    summary_at: "2026-06-12",
    summary_by: "agent",
  });

  it("returns an empty map when the file is absent", () => {
    expect(readSidecar(path).size).toBe(0);
  });

  it("upsert creates the file and round-trips a record", () => {
    upsertSidecar(path, rec("rs1:r:func:a#f@0", "h1"));
    expect(existsSync(path)).toBe(true);
    const m = readSidecar(path);
    expect(m.get("rs1:r:func:a#f@0")?.semantic_summary).toBe("summary rs1:r:func:a#f@0");
    expect(m.get("rs1:r:func:a#f@0")?.summary_of_hash).toBe("h1");
  });

  it("upsert dedups by id (no duplicate lines) and keeps the latest", () => {
    upsertSidecar(path, rec("rs1:r:func:a#f@0", "h1"));
    upsertSidecar(path, { ...rec("rs1:r:func:a#f@0", "h2"), semantic_summary: "updated" });
    const m = readSidecar(path);
    expect(m.size).toBe(1);
    expect(m.get("rs1:r:func:a#f@0")?.semantic_summary).toBe("updated");
    expect(m.get("rs1:r:func:a#f@0")?.summary_of_hash).toBe("h2");
  });

  it("upsert keeps multiple distinct ids sorted", () => {
    upsertSidecar(path, rec("rs1:r:func:b#g@0", "h2"));
    upsertSidecar(path, rec("rs1:r:func:a#f@0", "h1"));
    const m = readSidecar(path);
    expect([...m.keys()]).toEqual(["rs1:r:func:a#f@0", "rs1:r:func:b#g@0"]);
  });
});
