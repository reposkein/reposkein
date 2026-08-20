import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStore } from "./fakeStore.js";
import type { TargetRow } from "../src/profile/types.js";
import { computeBodyHash, writeDecision, type DecisionRecord } from "../src/store/decisions.js";
import { governingDecisionsFor } from "../src/profile/decisions.js";
import { makeGetContextProfile } from "../src/tools/getContextProfile.js";
import { makeImpact } from "../src/tools/impact.js";

const REPO_ID = "abc123";
const NODE_ID = `rs1:${REPO_ID}:func:svc.py#Svc.run@1`;

function target(overrides: Partial<TargetRow> = {}): TargetRow {
  return {
    id: NODE_ID,
    repo_id: REPO_ID,
    name: "run",
    qualified_name: "Svc.run",
    file_path: "svc.py",
    start_line: 2,
    end_line: 4,
    semantic_summary: "Runs the service.",
    summary_of_hash: "h1",
    content_hash: "h1",
    labels: ["Function"],
    ...overrides,
  };
}

function seed(root: string, id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
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
  writeDecision(root, rec);
  return rec;
}

const anchorFor = (nodeId: string, hash: string | null, path = "svc.py") => ({
  node_id: nodeId,
  path,
  name: "Svc.run",
  kind: "Function",
  hash,
});

describe("governingDecisionsFor", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-govern-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds direct anchors (suffix-tolerant) and classifies drift from the target hash", () => {
    seed(root, "adr:2026-08-01-current", { anchors: [anchorFor(NODE_ID, "h1")] });
    // Recorded in a fork with a different repo_id — suffix still matches.
    seed(root, "adr:2026-08-02-stale", { anchors: [anchorFor("rs1:fork:func:svc.py#Svc.run@1", "old")] });
    const g = governingDecisionsFor(root, target());
    // Same status → newest first (matches list_decisions ordering).
    expect(g.decisions.map((d) => [d.id, d.via, d.anchor_state])).toEqual([
      ["adr:2026-08-02-stale", "direct", "stale"],
      ["adr:2026-08-01-current", "direct", "current"],
    ]);
    expect(g.needing_review).toEqual(["adr:2026-08-02-stale"]);
  });

  it("matches path-prefix governance as 'contains' and exact file paths", () => {
    seed(root, "adr:2026-08-03-dir", { paths: ["src/"] });
    seed(root, "adr:2026-08-04-file", { paths: ["svc.py"] });
    seed(root, "adr:2026-08-05-elsewhere", { paths: ["other/"] });
    const g = governingDecisionsFor(root, target({ file_path: "src/svc.py" }));
    expect(g.decisions.map((d) => d.id)).toEqual(["adr:2026-08-03-dir"]);
    const g2 = governingDecisionsFor(root, target());
    expect(g2.decisions.map((d) => [d.id, d.via])).toEqual([["adr:2026-08-04-file", "contains"]]);
  });

  it("path governance never crosses into nested child repos (different coordinate system)", () => {
    seed(root, "adr:2026-08-03-dir", { paths: ["src/"] });
    // A child repo's node whose child-relative file_path collides with the prefix.
    const childTarget = target({
      id: "rs1:childrepo:func:src/svc.py#Svc.run@1",
      repo_id: "childrepo",
      file_path: "src/svc.py",
    });
    const g = governingDecisionsFor(root, childTarget, REPO_ID);
    expect(g.decisions).toEqual([]);
    // Direct anchors still govern child-repo nodes (that is the supported way).
    seed(root, "adr:2026-08-06-anchored", {
      anchors: [anchorFor("rs1:childrepo:func:src/svc.py#Svc.run@1", "h1", "src/svc.py")],
    });
    const g2 = governingDecisionsFor(root, childTarget, REPO_ID);
    expect(g2.decisions.map((d) => d.id)).toEqual(["adr:2026-08-06-anchored"]);
  });

  it("excludes rejected and superseded decisions and caps at 5, proposed after accepted", () => {
    seed(root, "adr:2026-08-01-rejected", { status: "rejected", paths: ["svc.py"] });
    seed(root, "adr:2026-08-02-superseded", { status: "superseded", paths: ["svc.py"] });
    seed(root, "adr:2026-08-03-proposed", { status: "proposed", paths: ["svc.py"] });
    for (let d = 4; d <= 9; d++) {
      seed(root, `adr:2026-08-0${d}-accepted`, { paths: ["svc.py"] });
    }
    const g = governingDecisionsFor(root, target());
    expect(g.decisions).toHaveLength(5);
    expect(g.decisions.every((d) => d.status === "accepted")).toBe(true);
    expect(g.truncated).toBe(true);
  });
});

describe("surfacing in tools", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-surface-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("get_context_profile attaches target.decisions and decisions_needing_review", async () => {
    seed(root, "adr:2026-08-02-stale", { anchors: [anchorFor(NODE_ID, "old")] });
    const store = fakeStore({
      getNode: async (_r, id) => (id === NODE_ID ? target() : null),
      callers: async () => [],
      callees: async () => [],
    });
    const profile = makeGetContextProfile(store, REPO_ID, root);
    const res = await profile({ node_id: NODE_ID });
    const out = JSON.parse(res.content[0]!.text) as Record<string, any>;
    expect(out.target.decisions).toEqual([
      { id: "adr:2026-08-02-stale", title: "Title adr:2026-08-02-stale", status: "accepted", via: "direct", anchor_state: "stale" },
    ]);
    expect(out.decisions_needing_review).toEqual(["adr:2026-08-02-stale"]);
  });

  it("get_context_profile omits the fields when nothing governs the target", async () => {
    const store = fakeStore({
      getNode: async (_r, id) => (id === NODE_ID ? target() : null),
      callers: async () => [],
      callees: async () => [],
    });
    const profile = makeGetContextProfile(store, REPO_ID, root);
    const out = JSON.parse((await profile({ node_id: NODE_ID })).content[0]!.text) as Record<string, any>;
    expect(out.target.decisions).toBeUndefined();
    expect(out.decisions_needing_review).toBeUndefined();
  });

  it("impact attaches governing_decisions over target and impacted rows", async () => {
    seed(root, "adr:2026-08-06-callers", { paths: ["callers/"] });
    seed(root, "adr:2026-08-07-target", { anchors: [anchorFor(NODE_ID, "h1")] });
    const callerId = `rs1:${REPO_ID}:func:callers/a.py#a@0`;
    const caller = target({ id: callerId, file_path: "callers/a.py", qualified_name: "a", content_hash: null });
    const store = fakeStore({
      getNode: async (_r, id) => (id === NODE_ID ? target() : id === callerId ? caller : null),
      callers: async (_r, id) =>
        id === NODE_ID
          ? [{ id: callerId, name: "a", semantic_summary: null, summary_of_hash: null, content_hash: null }]
          : [],
    });
    const impact = makeImpact(store, REPO_ID, root);
    const res = await impact({ node_id: NODE_ID });
    const out = JSON.parse(res.content[0]!.text) as Record<string, any>;
    const gov = out.governing_decisions as { id: string; governs: string[] }[];
    expect(gov.map((g) => g.id).sort()).toEqual(["adr:2026-08-06-callers", "adr:2026-08-07-target"]);
    expect(gov.find((g) => g.id === "adr:2026-08-06-callers")!.governs).toEqual([callerId]);
    expect(gov.find((g) => g.id === "adr:2026-08-07-target")!.governs).toEqual([NODE_ID]);
  });
});
