import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStore } from "./fakeStore.js";
import type { TargetRow } from "../src/profile/types.js";
import {
  computeBodyHash,
  decisionsDir,
  loadDecisions,
  mintDecisionId,
  resolveAnchorStates,
  writeDecision,
  type DecisionRecord,
} from "../src/store/decisions.js";

const REPO_ID = "abc123";

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const base: DecisionRecord = {
    id: "adr:2026-08-20-use-file-per-decision",
    title: "Use file-per-decision storage",
    status: "proposed",
    context: "Single JSONL files conflict on forges.",
    decision: "We will store one JSON file per decision.",
    anchors: [
      {
        node_id: `rs1:${REPO_ID}:file:mcp/src/store/decisions.ts`,
        path: "mcp/src/store/decisions.ts",
        name: "decisions.ts",
        kind: "File",
        hash: "h1",
      },
    ],
    paths: ["mcp/src/store/"],
    supersedes: [],
    decided_at: "2026-08-20",
    decided_by: "agent",
    trigger: { kind: "manual" },
    body_hash: "",
  };
  const rec = { ...base, ...overrides };
  rec.body_hash = computeBodyHash(rec);
  return rec;
}

function targetRow(overrides: Partial<TargetRow> = {}): TargetRow {
  return {
    id: `rs1:${REPO_ID}:file:mcp/src/store/decisions.ts`,
    repo_id: REPO_ID,
    name: "decisions.ts",
    qualified_name: "decisions.ts",
    file_path: "mcp/src/store/decisions.ts",
    start_line: 1,
    end_line: 10,
    semantic_summary: null,
    summary_of_hash: null,
    content_hash: "h1",
    labels: ["File"],
    ...overrides,
  };
}

describe("decisions store", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-decisions-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("mints ids as adr:<date>-<slug> from the title", () => {
    const id = mintDecisionId("2026-08-20", "Use File-per-Decision storage!", new Set());
    expect(id).toBe("adr:2026-08-20-use-file-per-decision-storage");
  });

  it("mints an ordinal suffix on same-day same-slug collision", () => {
    const taken = new Set(["adr:2026-08-20-use-x"]);
    expect(mintDecisionId("2026-08-20", "Use X", taken)).toBe("adr:2026-08-20-use-x.1");
    taken.add("adr:2026-08-20-use-x.1");
    expect(mintDecisionId("2026-08-20", "Use X", taken)).toBe("adr:2026-08-20-use-x.2");
  });

  it("salts the slug from content when a salt source is given", () => {
    // An ordinal is the wrong escape for the case that matters: two branches
    // recording a same-day same-title decision both see `.1` free, both mint
    // it, and both write the SAME filename with different bodies — the merge
    // conflict file-per-decision exists to prevent. A content-derived salt
    // gives them different files.
    const taken = new Set(["adr:2026-08-20-use-x"]);
    const a = mintDecisionId("2026-08-20", "Use X", taken, "because of reason A");
    const b = mintDecisionId("2026-08-20", "Use X", taken, "because of reason B");
    expect(a).toMatch(/^adr:2026-08-20-use-x-[0-9a-f]{6}$/);
    expect(b).toMatch(/^adr:2026-08-20-use-x-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });

  it("gives the same body the same salted id (recording twice is one decision)", () => {
    const taken = new Set(["adr:2026-08-20-use-x"]);
    expect(mintDecisionId("2026-08-20", "Use X", taken, "same body")).toBe(
      mintDecisionId("2026-08-20", "Use X", taken, "same body")
    );
  });

  it("falls back to an ordinal when even the salted id is taken", () => {
    const taken = new Set(["adr:2026-08-20-use-x"]);
    const salted = mintDecisionId("2026-08-20", "Use X", taken, "body");
    taken.add(salted);
    expect(mintDecisionId("2026-08-20", "Use X", taken, "body")).toBe(`${salted}.1`);
  });

  it("writes one canonical file per decision and round-trips it", () => {
    const rec = record();
    writeDecision(root, rec);
    const files = readdirSync(decisionsDir(root));
    expect(files).toEqual(["2026-08-20-use-file-per-decision.json"]);
    const text = readFileSync(join(decisionsDir(root), files[0]!), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    // Deterministic: writing the same record again produces identical bytes.
    writeDecision(root, rec);
    expect(readFileSync(join(decisionsDir(root), files[0]!), "utf8")).toBe(text);
    const { decisions, warnings } = loadDecisions(root);
    expect(warnings).toEqual([]);
    expect(decisions).toEqual([rec]);
  });

  it("loads an empty list when the directory is absent", () => {
    const { decisions, warnings } = loadDecisions(root);
    expect(decisions).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("skips malformed files (including conflict markers) with a warning", () => {
    writeDecision(root, record());
    writeFileSync(join(decisionsDir(root), "2026-08-21-broken.json"), "<<<<<<< HEAD\n{}\n");
    writeFileSync(join(decisionsDir(root), "2026-08-22-not-a-record.json"), JSON.stringify({ nope: 1 }));
    const { decisions, warnings } = loadDecisions(root);
    expect(decisions).toHaveLength(1);
    expect(warnings).toHaveLength(2);
  });

  it("keeps the higher-precedence status when two files carry the same id", () => {
    // Merge damage: same id in two files. superseded > deprecated > rejected > accepted > proposed.
    const a = record({ status: "accepted" });
    writeDecision(root, a);
    const dup = { ...a, status: "superseded" as const };
    mkdirSync(decisionsDir(root), { recursive: true });
    writeFileSync(
      join(decisionsDir(root), "2026-08-20-use-file-per-decision-dup.json"),
      JSON.stringify(dup) + "\n"
    );
    const { decisions } = loadDecisions(root);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.status).toBe("superseded");
  });

  it("body hash ignores status and anchor hashes but covers decision text", () => {
    const a = record();
    const statusFlipped = { ...a, status: "accepted" as const };
    expect(computeBodyHash(statusFlipped)).toBe(a.body_hash);
    const reStamped = {
      ...a,
      anchors: [{ ...a.anchors[0]!, hash: "h2" }],
    };
    expect(computeBodyHash(reStamped)).toBe(a.body_hash);
    const edited = { ...a, decision: "We will do something else." };
    expect(computeBodyHash(edited)).not.toBe(a.body_hash);
  });

  describe("resolveAnchorStates", () => {
    it("classifies current / stale / orphaned", async () => {
      const live = targetRow();
      const store = fakeStore({
        getNode: async (_repos, id) => (id === live.id ? live : null),
      });
      const rec = record({
        anchors: [
          { node_id: live.id, path: live.file_path, name: live.name, kind: "File", hash: "h1" },
          { node_id: live.id, path: live.file_path, name: live.name, kind: "File", hash: "old" },
          { node_id: `rs1:${REPO_ID}:file:gone.ts`, path: "gone.ts", name: "gone.ts", kind: "File", hash: "hx" },
        ],
      });
      const states = await resolveAnchorStates(store, [REPO_ID], rec.anchors);
      expect(states.map((s) => s.state)).toEqual(["current", "stale", "orphaned"]);
    });

    it("recovers moved anchors by content hash", async () => {
      const moved = targetRow({
        id: `rs1:${REPO_ID}:file:mcp/src/store/renamed.ts`,
        file_path: "mcp/src/store/renamed.ts",
      });
      const store = fakeStore({
        getNode: async () => null,
        findByContentHash: async (_repos, hash) => (hash === "h1" ? [moved] : []),
      });
      const rec = record();
      const states = await resolveAnchorStates(store, [REPO_ID], rec.anchors);
      expect(states[0]!.state).toBe("moved");
      expect(states[0]!.resolved_node_id).toBe(moved.id);
    });

    it("matches anchors recorded under a different repo_id by id suffix", async () => {
      const live = targetRow({ id: "rs1:otherrepo:file:mcp/src/store/decisions.ts", repo_id: "otherrepo" });
      const store = fakeStore({
        getNode: async (_repos, id) => (id === live.id ? live : null),
      });
      // Anchor was recorded in a fork whose repo_id differs.
      const anchors = [
        { node_id: `rs1:${REPO_ID}:file:mcp/src/store/decisions.ts`, path: "mcp/src/store/decisions.ts", name: "decisions.ts", kind: "File", hash: "h1" },
      ];
      const states = await resolveAnchorStates(store, ["otherrepo"], anchors);
      expect(states[0]!.state).toBe("current");
      expect(states[0]!.resolved_node_id).toBe(live.id);
    });
  });
});
