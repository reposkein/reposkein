import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBodyHash, loadDecisions, writeDecision, type DecisionRecord } from "../src/store/decisions.js";
import { exportAdrMarkdown, importAdrMarkdown, renderAdrMarkdown, parseAdrMarkdown } from "../src/cli/adr.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rs-adr-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const rec: DecisionRecord = {
    id,
    title: `Title ${id.slice(15)}`,
    status: "accepted",
    context: "The context prose.",
    decision: "We will do the thing.",
    consequences: "Things follow.",
    anchors: [
      { node_id: "rs1:r:file:src/x.ts", path: "src/x.ts", name: "x.ts", kind: "File", hash: "h1" },
    ],
    paths: ["src/"],
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

describe("adr export", () => {
  it("renders Nygard-style markdown, numbered deterministically by sorted id", () => {
    seed("adr:2026-08-20-second");
    seed("adr:2026-08-01-first");
    const out = join(dir, "docs", "adr");
    const written = exportAdrMarkdown(dir, out);
    expect(written).toBe(2);
    expect(readdirSync(out).sort()).toEqual(["0001-2026-08-01-first.md", "0002-2026-08-20-second.md"]);
    const text = readFileSync(join(out, "0001-2026-08-01-first.md"), "utf8");
    expect(text).toContain("# 1. Title first");
    expect(text).toContain("## Status");
    expect(text).toContain("accepted");
    expect(text).toContain("## Context");
    expect(text).toContain("The context prose.");
    expect(text).toContain("## Decision");
    expect(text).toContain("## Consequences");
    expect(text).toContain("src/x.ts"); // anchors appendix
  });

  it("is a derived view: re-export produces identical bytes", () => {
    seed("adr:2026-08-01-first");
    const out = join(dir, "docs", "adr");
    exportAdrMarkdown(dir, out);
    const before = readFileSync(join(out, "0001-2026-08-01-first.md"), "utf8");
    exportAdrMarkdown(dir, out);
    expect(readFileSync(join(out, "0001-2026-08-01-first.md"), "utf8")).toBe(before);
  });
});

describe("adr import", () => {
  it("parses a Nygard-style document into a record shell", () => {
    const md = [
      "# 4. Use PostgreSQL for persistence",
      "",
      "Date: 2026-03-01",
      "",
      "## Status",
      "",
      "Accepted",
      "",
      "## Context",
      "",
      "We need durable storage.",
      "It must be boring.",
      "",
      "## Decision",
      "",
      "We will use PostgreSQL.",
      "",
      "## Consequences",
      "",
      "Backups are required.",
      "",
    ].join("\n");
    const parsed = parseAdrMarkdown(md);
    expect(parsed).toEqual({
      title: "Use PostgreSQL for persistence",
      status: "accepted",
      date: "2026-03-01",
      context: "We need durable storage. It must be boring.",
      decision: "We will use PostgreSQL.",
      consequences: "Backups are required.",
    });
  });

  it("imports markdown files as human decisions and round-trips through export", () => {
    seed("adr:2026-08-01-first");
    const out = join(dir, "docs", "adr");
    exportAdrMarkdown(dir, out);
    // Import into a fresh repo dir.
    const dir2 = mkdtempSync(join(tmpdir(), "rs-adr2-"));
    try {
      const imported = importAdrMarkdown(dir2, out, { fallbackDate: "2026-08-20" });
      expect(imported.imported).toBe(1);
      const { decisions } = loadDecisions(dir2);
      expect(decisions).toHaveLength(1);
      const rec = decisions[0]!;
      expect(rec.id).toBe("adr:2026-08-01-title-first");
      expect(rec.decided_by).toBe("human");
      expect(rec.status).toBe("accepted");
      expect(rec.anchors).toEqual([]); // anchors come later via record/reaffirm flows
      expect(rec.context).toBe("The context prose.");
      expect(rec.body_hash).toBe(computeBodyHash(rec));
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("skips documents it cannot parse and reports them", () => {
    const src = join(dir, "docs", "adr");
    const dir2 = mkdtempSync(join(tmpdir(), "rs-adr3-"));
    try {
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "notes.md"), "just some notes, no sections\n");
      const res = importAdrMarkdown(dir2, src, { fallbackDate: "2026-08-20" });
      expect(res.imported).toBe(0);
      expect(res.skipped).toEqual(["notes.md"]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("renderAdrMarkdown ends with a single trailing newline", () => {
    const rec = seed("adr:2026-08-01-first");
    const text = renderAdrMarkdown(rec, 7);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).toContain("# 7. Title first");
  });
});
