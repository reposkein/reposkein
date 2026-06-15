import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../src/cli/doctor.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-doctor-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("doctor runChecks", () => {
  it("flags an unindexed repo (no .reposkein/nodes.jsonl)", async () => {
    const report = await runChecks(dir);
    const indexed = report.checks.find((c) => c.id === "indexed")!;
    expect(indexed.ok).toBe(false);
    expect(report.ok).toBe(false); // 'indexed' is critical
    expect(indexed.fix).toMatch(/index/i);
  });

  it("passes the index check and counts nodes when nodes.jsonl is present", async () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    // two minimal node lines (the check counts lines, not schema)
    writeFileSync(
      join(dir, ".reposkein", "nodes.jsonl"),
      `{"id":"rs1:r:Function:a.py#f@0"}\n{"id":"rs1:r:Function:a.py#g@0"}\n`
    );
    const report = await runChecks(dir);
    const indexed = report.checks.find((c) => c.id === "indexed")!;
    expect(indexed.ok).toBe(true);
    expect(indexed.detail).toMatch(/2 nodes/);
  });
});
