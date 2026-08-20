import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStore } from "./fakeStore.js";
import type { TargetRow } from "../src/profile/types.js";
import { computeBodyHash, writeDecision, type DecisionRecord } from "../src/store/decisions.js";
import { makeListDecisions } from "../src/tools/listDecisions.js";
import { makeGetDecision } from "../src/tools/getDecision.js";

const REPO_ID = "abc123";
const NODE_ID = `rs1:${REPO_ID}:func:svc.py#Svc.run@1`;

function liveNode(hash: string): TargetRow {
  return {
    id: NODE_ID,
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

function seed(
  root: string,
  id: string,
  overrides: Partial<DecisionRecord> = {}
): DecisionRecord {
  const rec: DecisionRecord = {
    id,
    title: `Title for ${id}`,
    status: "accepted",
    context: "Some context prose.",
    decision: "We will do the thing.",
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

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("list_decisions", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-list-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists newest-first with anchor counts and respects limit", async () => {
    seed(root, "adr:2026-08-01-older");
    seed(root, "adr:2026-08-20-newer", {
      anchors: [
        { node_id: NODE_ID, path: "svc.py", name: "Svc.run", kind: "Function", hash: "h1" },
        { node_id: `rs1:${REPO_ID}:func:gone.py#g@0`, path: "gone.py", name: "g", kind: "Function", hash: "hx" },
      ],
    });
    const store = fakeStore({
      getNode: async (_r, id) => (id === NODE_ID ? liveNode("h1") : null),
    });
    const list = makeListDecisions(store, REPO_ID, root);
    const out = parse(await list({}));
    const rows = out.decisions as Record<string, unknown>[];
    expect(rows.map((r) => r.id)).toEqual(["adr:2026-08-20-newer", "adr:2026-08-01-older"]);
    expect(rows[0]!.anchor_counts).toEqual({ current: 1, stale: 0, moved: 0, orphaned: 1 });
    const limited = parse(await list({ limit: 1 }));
    expect((limited.decisions as unknown[]).length).toBe(1);
    expect(limited.truncated).toBe(true);
  });

  it("filters by status, anchor node id, anchor path prefix, and free text", async () => {
    seed(root, "adr:2026-08-10-api-shape", {
      status: "proposed",
      decision: "We will expose a REST API.",
      paths: ["mcp/src/"],
    });
    seed(root, "adr:2026-08-11-storage", {
      anchors: [{ node_id: NODE_ID, path: "svc.py", name: "Svc.run", kind: "Function", hash: "h1" }],
    });
    const store = fakeStore({ getNode: async () => null });
    const list = makeListDecisions(store, REPO_ID, root);
    const byStatus = parse(await list({ status: "proposed" }));
    expect((byStatus.decisions as { id: string }[]).map((d) => d.id)).toEqual(["adr:2026-08-10-api-shape"]);
    const byAnchor = parse(await list({ anchor: NODE_ID }));
    expect((byAnchor.decisions as { id: string }[]).map((d) => d.id)).toEqual(["adr:2026-08-11-storage"]);
    const byFile = parse(await list({ anchor: "svc.py" }));
    expect((byFile.decisions as { id: string }[]).map((d) => d.id)).toEqual(["adr:2026-08-11-storage"]);
    const byPathPrefix = parse(await list({ anchor: "mcp/src/store/x.ts" }));
    expect((byPathPrefix.decisions as { id: string }[]).map((d) => d.id)).toEqual(["adr:2026-08-10-api-shape"]);
    const byText = parse(await list({ q: "rest api" }));
    expect((byText.decisions as { id: string }[]).map((d) => d.id)).toEqual(["adr:2026-08-10-api-shape"]);
  });

  it("neutralizes prose on the read path", async () => {
    seed(root, "adr:2026-08-12-hostile", { title: "Evil ```fence``` [link](http://x) title" });
    const store = fakeStore({ getNode: async () => null });
    const list = makeListDecisions(store, REPO_ID, root);
    const out = parse(await list({}));
    expect((out.decisions as { title: string }[])[0]!.title).toBe("Evil fence link title");
  });
});

describe("get_decision", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-get-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns the full record with live anchor states and the supersession chain", async () => {
    seed(root, "adr:2026-08-01-old-way", { status: "superseded", superseded_by: "adr:2026-08-20-new-way" });
    seed(root, "adr:2026-08-20-new-way", {
      supersedes: ["adr:2026-08-01-old-way"],
      anchors: [{ node_id: NODE_ID, path: "svc.py", name: "Svc.run", kind: "Function", hash: "old" }],
    });
    const store = fakeStore({ getNode: async (_r, id) => (id === NODE_ID ? liveNode("new") : null) });
    const get = makeGetDecision(store, REPO_ID, root);
    const out = parse(await get({ decision_id: "adr:2026-08-20-new-way" }));
    expect(out.id).toBe("adr:2026-08-20-new-way");
    expect(out.decision).toBe("We will do the thing.");
    const anchors = out.anchors as Record<string, unknown>[];
    expect(anchors[0]!.state).toBe("stale");
    expect(out.supersedes).toEqual(["adr:2026-08-01-old-way"]);
    const old = parse(await get({ decision_id: "adr:2026-08-01-old-way" }));
    expect(old.superseded_by).toBe("adr:2026-08-20-new-way");
  });

  it("errors on an unknown id", async () => {
    const store = fakeStore({});
    const get = makeGetDecision(store, REPO_ID, root);
    const res = await get({ decision_id: "adr:2026-01-01-nope" });
    expect(res.isError).toBe(true);
  });
});
