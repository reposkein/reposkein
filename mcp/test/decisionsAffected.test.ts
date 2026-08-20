import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBodyHash, writeDecision, type DecisionRecord } from "../src/store/decisions.js";
import {
  decisionsAffectedBy,
  readPendingDelta,
  pendingDeltaPath,
  type GraphDeltaJson,
} from "../src/indexer/decisionsAffected.js";
import { makeReindexFile } from "../src/tools/indexerTools.js";

const REPO_ID = "abc123";

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

const anchor = (nodeId: string, path = "src/x.ts") => ({
  node_id: nodeId,
  path,
  name: "x",
  kind: "Function",
  hash: "h1",
});

const delta = (overrides: Partial<GraphDeltaJson> = {}): GraphDeltaJson => ({
  added: [],
  removed: [],
  modified: [],
  counts: { added: 0, removed: 0, modified: 0 },
  truncated: false,
  ...overrides,
});

describe("decisionsAffectedBy", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rs-affected-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("flags modified and removed anchors, suffix-tolerant across repo ids", () => {
    seed(root, "adr:2026-08-01-a", { anchors: [anchor(`rs1:${REPO_ID}:func:src/x.ts#f@0`)] });
    seed(root, "adr:2026-08-02-b", { anchors: [anchor("rs1:fork:func:src/y.ts#g@0", "src/y.ts")] });
    seed(root, "adr:2026-08-03-untouched", { anchors: [anchor(`rs1:${REPO_ID}:func:src/z.ts#h@0`, "src/z.ts")] });
    const affected = decisionsAffectedBy(root, delta({
      modified: [`rs1:${REPO_ID}:func:src/x.ts#f@0`],
      removed: [`rs1:${REPO_ID}:func:src/y.ts#g@0`],
    }), REPO_ID);
    expect(affected).toEqual([
      { decision_id: "adr:2026-08-01-a", title: "Title adr:2026-08-01-a", why: "anchor_modified" },
      { decision_id: "adr:2026-08-02-b", title: "Title adr:2026-08-02-b", why: "anchor_removed" },
    ]);
  });

  it("flags path-governed decisions when a governed file node changes", () => {
    seed(root, "adr:2026-08-01-dir", { paths: ["src/store/"] });
    const affected = decisionsAffectedBy(root, delta({
      modified: [`rs1:${REPO_ID}:file:src/store/decisions.ts`],
    }), REPO_ID);
    expect(affected).toEqual([
      { decision_id: "adr:2026-08-01-dir", title: "Title adr:2026-08-01-dir", why: "governed_path_changed" },
    ]);
  });

  it("path governance is scoped to the root repo (nested-repo paths are a different coordinate system)", () => {
    seed(root, "adr:2026-08-01-dir", { paths: ["src/store/"] });
    // A nested child repo's file node has the same-looking relative path.
    const childOnly = decisionsAffectedBy(
      root,
      delta({ modified: ["rs1:childrepo:file:src/store/x.ts"] }),
      REPO_ID
    );
    expect(childOnly).toEqual([]);
    const rootHit = decisionsAffectedBy(
      root,
      delta({ modified: [`rs1:${REPO_ID}:file:src/store/x.ts`] }),
      REPO_ID
    );
    expect(rootHit.map((a) => a.decision_id)).toEqual(["adr:2026-08-01-dir"]);
  });

  it("ignores decisions that are not accepted or proposed", () => {
    seed(root, "adr:2026-08-01-old", {
      status: "superseded",
      anchors: [anchor(`rs1:${REPO_ID}:func:src/x.ts#f@0`)],
    });
    expect(
      decisionsAffectedBy(root, delta({ modified: [`rs1:${REPO_ID}:func:src/x.ts#f@0`] }), REPO_ID)
    ).toEqual([]);
  });
});

describe("readPendingDelta", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rs-pending-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns null when absent and consumes the file when present", () => {
    expect(readPendingDelta(root)).toBeNull();
    const p = pendingDeltaPath(root);
    mkdirSync(join(root, ".reposkein", "local"), { recursive: true });
    writeFileSync(p, JSON.stringify(delta({ modified: ["x"], counts: { added: 0, removed: 0, modified: 1 } })));
    const d = readPendingDelta(root);
    expect(d?.modified).toEqual(["x"]);
    expect(existsSync(p)).toBe(false); // consumed
    expect(readPendingDelta(root)).toBeNull();
  });

  it("tolerates a corrupt pending file (consumes it, returns null)", () => {
    const p = pendingDeltaPath(root);
    mkdirSync(join(root, ".reposkein", "local"), { recursive: true });
    writeFileSync(p, "{not json");
    expect(readPendingDelta(root)).toBeNull();
    expect(existsSync(p)).toBe(false);
  });
});

describe("reindex_file surfaces decisions_affected", () => {
  let root: string;
  let prevRepoPath: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rs-reindex-"));
    prevRepoPath = process.env.REPOSKEIN_REPO_PATH;
    process.env.REPOSKEIN_REPO_PATH = root;
  });
  afterEach(() => {
    if (prevRepoPath === undefined) delete process.env.REPOSKEIN_REPO_PATH;
    else process.env.REPOSKEIN_REPO_PATH = prevRepoPath;
    rmSync(root, { recursive: true, force: true });
  });

  it("merges the run delta with the pending file and cross-refs decisions", async () => {
    seed(root, "adr:2026-08-01-a", { anchors: [anchor(`rs1:${REPO_ID}:func:src/x.ts#f@0`)] });
    seed(root, "adr:2026-08-02-b", { anchors: [anchor(`rs1:${REPO_ID}:func:src/y.ts#g@0`, "src/y.ts")] });
    // A pending delta from an earlier hook-driven index (stdout was discarded).
    mkdirSync(join(root, ".reposkein", "local"), { recursive: true });
    writeFileSync(
      pendingDeltaPath(root),
      JSON.stringify(delta({ modified: [`rs1:${REPO_ID}:func:src/y.ts#g@0`], counts: { added: 0, removed: 0, modified: 1 } }))
    );
    const reindex = makeReindexFile(REPO_ID, {
      run: async () => ({
        ok: true,
        nodes: 1,
        edges: 0,
        files: 1,
        warnings: [],
        graph_delta: delta({ modified: [`rs1:${REPO_ID}:func:src/x.ts#f@0`], counts: { added: 0, removed: 0, modified: 1 } }),
      }),
    });
    const res = await reindex({ path: "src/x.ts" });
    const out = JSON.parse(res.content[0]!.text) as Record<string, any>;
    expect(out.graph_delta.modified.sort()).toEqual([
      `rs1:${REPO_ID}:func:src/x.ts#f@0`,
      `rs1:${REPO_ID}:func:src/y.ts#g@0`,
    ]);
    expect((out.decisions_affected as { decision_id: string }[]).map((d) => d.decision_id).sort()).toEqual([
      "adr:2026-08-01-a",
      "adr:2026-08-02-b",
    ]);
    expect(existsSync(pendingDeltaPath(root))).toBe(false);
  });

  it("marks the cross-reference incomplete when the delta was truncated", async () => {
    seed(root, "adr:2026-08-01-a", { anchors: [anchor(`rs1:${REPO_ID}:func:src/x.ts#f@0`)] });
    const reindex = makeReindexFile(REPO_ID, {
      run: async () => ({
        ok: true,
        nodes: 1,
        edges: 0,
        files: 1,
        warnings: [],
        graph_delta: delta({
          modified: [`rs1:${REPO_ID}:func:src/other.ts#o@0`],
          counts: { added: 0, removed: 0, modified: 120 },
          truncated: true,
        }),
      }),
    });
    const out = JSON.parse((await reindex({ path: "src/x.ts" })).content[0]!.text) as Record<string, any>;
    expect(out.decisions_check_incomplete).toBe(true);
  });

  it("init_cpg_skeleton indexing a different path leaves the env repo's pending delta alone", async () => {
    const { makeInitCpgSkeleton } = await import("../src/tools/indexerTools.js");
    mkdirSync(join(root, ".reposkein", "local"), { recursive: true });
    writeFileSync(
      pendingDeltaPath(root),
      JSON.stringify(delta({ modified: ["rs1:abc123:func:src/x.ts#f@0"], counts: { added: 0, removed: 0, modified: 1 } }))
    );
    const other = mkdtempSync(join(tmpdir(), "rs-other-"));
    try {
      const init = makeInitCpgSkeleton(REPO_ID, {
        run: async () => ({ ok: true, nodes: 1, edges: 0, files: 1, warnings: [] }),
      });
      const out = JSON.parse((await init({ path: other })).content[0]!.text) as Record<string, any>;
      expect(out.decisions_affected).toBeUndefined();
      expect(existsSync(pendingDeltaPath(root))).toBe(true); // NOT consumed
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("omits the fields when there is no drift", async () => {
    const reindex = makeReindexFile(REPO_ID, {
      run: async () => ({ ok: true, nodes: 1, edges: 0, files: 1, warnings: [] }),
    });
    const out = JSON.parse((await reindex({ path: "src/x.ts" })).content[0]!.text) as Record<string, any>;
    expect(out.graph_delta).toBeUndefined();
    expect(out.decisions_affected).toBeUndefined();
  });
});
