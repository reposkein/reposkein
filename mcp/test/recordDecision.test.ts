import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStore } from "./fakeStore.js";
import type { TargetRow } from "../src/profile/types.js";
import { loadDecisions, writeDecision, computeBodyHash, type DecisionRecord } from "../src/store/decisions.js";
import { makeRecordDecision } from "../src/tools/recordDecision.js";
import { makeSetDecisionStatus } from "../src/tools/setDecisionStatus.js";
import { makeReaffirmDecision } from "../src/tools/reaffirmDecision.js";

const REPO_ID = "abc123";
const NODE_ID = `rs1:${REPO_ID}:func:svc.py#Svc.run@1`;

function liveNode(hash: string, id = NODE_ID): TargetRow {
  return {
    id,
    repo_id: REPO_ID,
    name: "run",
    qualified_name: "Svc.run",
    file_path: "svc.py",
    start_line: 2,
    end_line: 4,
    semantic_summary: null,
    summary_of_hash: null,
    content_hash: hash,
    labels: ["Function"],
  };
}

function parse(result: { content: { text: string }[]; isError?: boolean }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const TODAY = () => "2026-08-20";

describe("record_decision", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-record-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const baseArgs = {
    title: "Use X for Y",
    context: "We needed a Y strategy.",
    decision: "We will use X.",
  };

  it("records a decision with default proposed status and stamped anchors", async () => {
    const store = fakeStore({ getNode: async (_r, id) => (id === NODE_ID ? liveNode("h1") : null) });
    const record = makeRecordDecision(store, REPO_ID, root, { today: TODAY });
    const res = await record({ ...baseArgs, anchor_node_ids: [NODE_ID], anchor_paths: ["mcp/src/"] });
    expect(res.isError).toBeUndefined();
    const out = parse(res);
    expect(out.decision_id).toBe("adr:2026-08-20-use-x-for-y");
    expect(out.status).toBe("proposed");
    const { decisions } = loadDecisions(root);
    expect(decisions).toHaveLength(1);
    const rec = decisions[0]!;
    expect(rec.status).toBe("proposed");
    expect(rec.decided_at).toBe("2026-08-20");
    expect(rec.anchors).toEqual([
      { node_id: NODE_ID, path: "svc.py", name: "Svc.run", kind: "Function", hash: "h1" },
    ]);
    expect(rec.paths).toEqual(["mcp/src/"]);
    expect(rec.body_hash).toBe(computeBodyHash(rec));
  });

  it("reports unresolved anchor ids instead of failing", async () => {
    const store = fakeStore({ getNode: async () => null });
    const record = makeRecordDecision(store, REPO_ID, root, { today: TODAY });
    const res = await record({ ...baseArgs, anchor_node_ids: ["rs1:abc123:func:gone@0"] });
    const out = parse(res);
    expect(out.unresolved).toEqual(["rs1:abc123:func:gone@0"]);
    const { decisions } = loadDecisions(root);
    expect(decisions[0]!.anchors).toEqual([]);
  });

  it("rejects prose that fails sanitization", async () => {
    const store = fakeStore({});
    const record = makeRecordDecision(store, REPO_ID, root, { today: TODAY });
    const res = await record({ ...baseArgs, context: "```evil```" });
    expect(res.isError).toBe(true);
  });

  it("rejects glob anchor paths", async () => {
    const store = fakeStore({});
    const record = makeRecordDecision(store, REPO_ID, root, { today: TODAY });
    const res = await record({ ...baseArgs, anchor_paths: ["src/**/*.ts"] });
    expect(res.isError).toBe(true);
  });

  it("mints an ordinal id on same-day same-slug collision instead of overwriting", async () => {
    const store = fakeStore({});
    const record = makeRecordDecision(store, REPO_ID, root, { today: TODAY });
    await record({ ...baseArgs });
    const res2 = await record({ ...baseArgs, decision: "We will use X differently." });
    const out2 = parse(res2);
    expect(out2.decision_id).toBe("adr:2026-08-20-use-x-for-y.1");
    expect(loadDecisions(root).decisions).toHaveLength(2);
  });

  it("flips superseded records atomically and links both directions", async () => {
    const store = fakeStore({});
    const record = makeRecordDecision(store, REPO_ID, root, { today: TODAY });
    await record({ ...baseArgs, status: "accepted" });
    const res = await record({
      title: "Use Z instead of X",
      context: "X did not scale.",
      decision: "We will use Z.",
      supersedes: ["adr:2026-08-20-use-x-for-y"],
    });
    const out = parse(res);
    expect(out.superseded).toEqual(["adr:2026-08-20-use-x-for-y"]);
    const { decisions } = loadDecisions(root);
    const old = decisions.find((d) => d.id === "adr:2026-08-20-use-x-for-y")!;
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe("adr:2026-08-20-use-z-instead-of-x");
  });

  it("refuses to supersede an unknown decision id", async () => {
    const store = fakeStore({});
    const record = makeRecordDecision(store, REPO_ID, root, { today: TODAY });
    const res = await record({ ...baseArgs, supersedes: ["adr:2026-01-01-nope"] });
    expect(res.isError).toBe(true);
    expect(loadDecisions(root).decisions).toHaveLength(0);
  });

  it("runs the refresh hook before stamping anchor hashes", async () => {
    let hash = "pre-edit";
    const store = fakeStore({ getNode: async (_r, id) => (id === NODE_ID ? liveNode(hash) : null) });
    const record = makeRecordDecision(store, REPO_ID, root, {
      today: TODAY,
      refresh: async () => {
        hash = "post-edit";
      },
    });
    await record({ ...baseArgs, anchor_node_ids: [NODE_ID] });
    expect(loadDecisions(root).decisions[0]!.anchors[0]!.hash).toBe("post-edit");
  });
});

describe("set_decision_status", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-status-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function seed(status: DecisionRecord["status"]): DecisionRecord {
    const rec: DecisionRecord = {
      id: "adr:2026-08-20-use-x",
      title: "Use X",
      status,
      context: "ctx",
      decision: "We will use X.",
      anchors: [],
      paths: [],
      supersedes: [],
      decided_at: "2026-08-20",
      decided_by: "agent",
      trigger: { kind: "manual" },
      body_hash: "",
    };
    rec.body_hash = computeBodyHash(rec);
    writeDecision(root, rec);
    return rec;
  }

  it("ratifies proposed → accepted", async () => {
    seed("proposed");
    const set = makeSetDecisionStatus(root);
    const res = await set({ decision_id: "adr:2026-08-20-use-x", status: "accepted" });
    expect(res.isError).toBeUndefined();
    expect(loadDecisions(root).decisions[0]!.status).toBe("accepted");
  });

  it("rejects illegal transitions", async () => {
    seed("rejected");
    const set = makeSetDecisionStatus(root);
    const res = await set({ decision_id: "adr:2026-08-20-use-x", status: "accepted" });
    expect(res.isError).toBe(true);
    // proposed → deprecated is also illegal (deprecate is for accepted decisions).
    rmSync(join(root, ".reposkein"), { recursive: true, force: true });
    seed("proposed");
    const res2 = await set({ decision_id: "adr:2026-08-20-use-x", status: "deprecated" });
    expect(res2.isError).toBe(true);
  });

  it("errors on an unknown decision id", async () => {
    const set = makeSetDecisionStatus(root);
    const res = await set({ decision_id: "adr:2026-01-01-nope", status: "accepted" });
    expect(res.isError).toBe(true);
  });
});

describe("reaffirm_decision", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-reaffirm-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("re-stamps stale anchors to the live hash without changing the body hash", async () => {
    const rec: DecisionRecord = {
      id: "adr:2026-08-20-use-x",
      title: "Use X",
      status: "accepted",
      context: "ctx",
      decision: "We will use X.",
      anchors: [{ node_id: NODE_ID, path: "svc.py", name: "Svc.run", kind: "Function", hash: "old" }],
      paths: [],
      supersedes: [],
      decided_at: "2026-08-20",
      decided_by: "agent",
      trigger: { kind: "manual" },
      body_hash: "",
    };
    rec.body_hash = computeBodyHash(rec);
    writeDecision(root, rec);
    const store = fakeStore({ getNode: async (_r, id) => (id === NODE_ID ? liveNode("new") : null) });
    const reaffirm = makeReaffirmDecision(store, REPO_ID, root);
    const res = await reaffirm({ decision_id: "adr:2026-08-20-use-x" });
    expect(res.isError).toBeUndefined();
    const after = loadDecisions(root).decisions[0]!;
    expect(after.anchors[0]!.hash).toBe("new");
    expect(after.body_hash).toBe(rec.body_hash);
    expect(computeBodyHash(after)).toBe(rec.body_hash);
  });

  it("rebinds a moved anchor to its recovered node id", async () => {
    const movedId = `rs1:${REPO_ID}:func:renamed.py#Svc.run@1`;
    const rec: DecisionRecord = {
      id: "adr:2026-08-20-use-x",
      title: "Use X",
      status: "accepted",
      context: "ctx",
      decision: "We will use X.",
      anchors: [{ node_id: NODE_ID, path: "svc.py", name: "Svc.run", kind: "Function", hash: "h1" }],
      paths: [],
      supersedes: [],
      decided_at: "2026-08-20",
      decided_by: "agent",
      trigger: { kind: "manual" },
      body_hash: "",
    };
    rec.body_hash = computeBodyHash(rec);
    writeDecision(root, rec);
    const store = fakeStore({
      getNode: async (_r, id) => (id === movedId ? { ...liveNode("h1", movedId), file_path: "renamed.py" } : null),
      findByContentHash: async (_r, hash) =>
        hash === "h1" ? [{ ...liveNode("h1", movedId), file_path: "renamed.py" }] : [],
    });
    const reaffirm = makeReaffirmDecision(store, REPO_ID, root);
    await reaffirm({ decision_id: "adr:2026-08-20-use-x" });
    const after = loadDecisions(root).decisions[0]!;
    expect(after.anchors[0]!.node_id).toBe(movedId);
    expect(after.anchors[0]!.path).toBe("renamed.py");
    // Rebinding anchors is a body change by design: doctor must not flag it.
    expect(after.body_hash).toBe(computeBodyHash(after));
  });

  it("errors on an unknown decision id", async () => {
    const store = fakeStore({});
    const reaffirm = makeReaffirmDecision(store, REPO_ID, root);
    const res = await reaffirm({ decision_id: "adr:2026-01-01-nope" });
    expect(res.isError).toBe(true);
  });
});
