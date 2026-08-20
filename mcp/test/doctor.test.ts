import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../src/cli/doctor.js";
import { decisionChecks } from "../src/cli/doctorDecisions.js";
import { computeBodyHash, writeDecision, decisionsDir, type DecisionRecord } from "../src/store/decisions.js";

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

function seedDecision(id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const rec: DecisionRecord = {
    id,
    title: `Title ${id}`,
    status: "accepted",
    context: "ctx",
    decision: "We decided.",
    anchors: [],
    paths: [],
    supersedes: [],
    decided_at: id.slice(4, 14),
    decided_by: "agent",
    trigger: { kind: "manual" },
    body_hash: "",
    ...overrides,
  };
  rec.body_hash = computeBodyHash(rec);
  writeDecision(dir, rec);
  return rec;
}

describe("doctor decision checks", () => {
  it("passes cleanly on a healthy decision log (and on no log at all)", () => {
    expect(decisionChecks(dir).every((c) => c.ok)).toBe(true);
    seedDecision("adr:2026-08-01-a");
    seedDecision("adr:2026-08-02-b", { supersedes: ["adr:2026-08-01-a"] });
    const checks = decisionChecks(dir);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.every((c) => !c.critical)).toBe(true); // degrade, don't block
  });

  it("flags a hand-edited body (body_hash mismatch)", () => {
    const rec = seedDecision("adr:2026-08-01-a");
    const tampered = { ...rec, decision: "We decided otherwise." }; // body_hash left stale
    writeFileSync(
      join(decisionsDir(dir), "2026-08-01-a.json"),
      JSON.stringify(tampered) + "\n"
    );
    const integrity = decisionChecks(dir).find((c) => c.id === "decisions_integrity")!;
    expect(integrity.ok).toBe(false);
    expect(integrity.detail).toContain("adr:2026-08-01-a");
  });

  it("flags dangling supersedes references and duplicate ids across files", () => {
    const rec = seedDecision("adr:2026-08-01-a", { supersedes: ["adr:2026-01-01-ghost"] });
    writeFileSync(
      join(decisionsDir(dir), "2026-08-01-a-copy.json"),
      JSON.stringify({ ...rec, status: "proposed" }) + "\n"
    );
    const refs = decisionChecks(dir).find((c) => c.id === "decisions_refs")!;
    expect(refs.ok).toBe(false);
    expect(refs.detail).toContain("adr:2026-01-01-ghost");
    const dupes = decisionChecks(dir).find((c) => c.id === "decisions_duplicates")!;
    expect(dupes.ok).toBe(false);
    expect(dupes.detail).toContain("adr:2026-08-01-a");
  });

  it("flags a supersession cycle and malformed files", () => {
    seedDecision("adr:2026-08-01-a", { supersedes: ["adr:2026-08-02-b"], status: "superseded", superseded_by: "adr:2026-08-02-b" });
    seedDecision("adr:2026-08-02-b", { supersedes: ["adr:2026-08-01-a"] });
    // A decision merely reachable from the cycle members must not be reported
    // as part of the cycle.
    seedDecision("adr:2026-08-03-bystander", { status: "superseded" });
    writeFileSync(join(decisionsDir(dir), "2026-08-04-broken.json"), "<<<<<<< HEAD\n{}\n");
    const checks = decisionChecks(dir);
    const cycles = checks.find((c) => c.id === "decisions_cycles")!;
    expect(cycles.ok).toBe(false);
    expect(cycles.detail).toContain("adr:2026-08-01-a");
    expect(cycles.detail).toContain("adr:2026-08-02-b");
    expect(cycles.detail).not.toContain("bystander");
    expect(checks.find((c) => c.id === "decisions_parse")!.ok).toBe(false);
  });

  it("warns past the active-record budget", () => {
    for (let i = 0; i < 101; i++) {
      seedDecision(`adr:2026-08-01-n${String(i).padStart(3, "0")}`);
    }
    const budget = decisionChecks(dir).find((c) => c.id === "decisions_budget")!;
    expect(budget.ok).toBe(false);
    expect(budget.detail).toMatch(/101/);
  });
});
