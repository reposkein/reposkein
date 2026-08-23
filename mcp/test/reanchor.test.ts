import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStore } from "./fakeStore.js";
import type { TargetRow } from "../src/profile/types.js";
import {
  computeBodyHash,
  loadDecisions,
  verifyBodyHash,
  writeDecision,
  type DecisionRecord,
} from "../src/store/decisions.js";
import { applyReanchor, planReanchor } from "../src/store/reanchor.js";

const REPO = "r1";
const node = (id: string, over: Partial<TargetRow> = {}): TargetRow => ({
  id,
  repo_id: REPO,
  name: "f",
  qualified_name: "mod.f",
  file_path: "src/new.py",
  start_line: 1,
  end_line: 2,
  semantic_summary: null,
  summary_of_hash: null,
  content_hash: "h1",
  labels: ["Function"],
  ...over,
});

const rec = (over: Partial<DecisionRecord> = {}): DecisionRecord => {
  const base: DecisionRecord = {
    id: "adr:2026-08-01-x",
    title: "X",
    status: "accepted",
    context: "ctx",
    decision: "dec",
    anchors: [
      { node_id: `rs1:${REPO}:func:src/old.py#f@0`, path: "src/old.py", name: "mod.f", kind: "Function", hash: "h1" },
    ],
    paths: [],
    supersedes: [],
    decided_at: "2026-08-01",
    decided_by: "agent",
    trigger: { kind: "manual" },
    body_hash: "",
    ...over,
  };
  base.body_hash = computeBodyHash(base);
  return base;
};

describe("planReanchor", () => {
  it("keeps a live, unchanged anchor", async () => {
    const store = fakeStore({
      getNode: async (_ids, id) =>
        id === `rs1:${REPO}:func:src/old.py#f@0` ? node(id, { file_path: "src/old.py" }) : null,
    });
    const plan = await planReanchor(store, [REPO], rec());
    expect(plan.anchors[0]!.action).toBe("keep");
    expect(plan.changed).toBe(false);
    expect(plan.unresolved).toBe(0);
  });

  it("marks stale (id live, content changed) and does not rebind it", async () => {
    const store = fakeStore({
      getNode: async (_ids, id) =>
        id === `rs1:${REPO}:func:src/old.py#f@0` ? node(id, { content_hash: "h2" }) : null,
    });
    const plan = await planReanchor(store, [REPO], rec());
    expect(plan.anchors[0]!.action).toBe("stale");
    expect(plan.changed).toBe(false);
  });

  it("rebinds via repo_id-suffix match, preserving the recorded hash", async () => {
    const r = rec({
      anchors: [{ node_id: "rs1:oldrepo:func:src/old.py#f@0", path: "src/old.py", name: "mod.f", kind: "Function", hash: "hstale" }],
    });
    const liveId = `rs1:${REPO}:func:src/old.py#f@0`;
    const store = fakeStore({
      getNode: async (_ids, id) => (id === liveId ? node(liveId, { content_hash: "hnew" }) : null),
      findByContentHash: async () => [node(liveId)],
    });
    const plan = await planReanchor(store, [REPO], r);
    expect(plan.anchors[0]!.action).toBe("rebind");
    expect(plan.anchors[0]!.to!.node_id).toBe(liveId);
    // pointer repaired, staleness preserved for reaffirm to judge:
    expect(plan.anchors[0]!.to!.hash).toBe("hstale");
    expect(plan.changed).toBe(true);
  });

  it("rebinds a dead id via a UNIQUE content-hash match", async () => {
    const liveId = `rs1:${REPO}:func:src/new.py#f@0`;
    const store = fakeStore({
      getNode: async () => null,
      findByContentHash: async (_ids, hash) => (hash === "h1" ? [node(liveId)] : []),
    });
    const plan = await planReanchor(store, [REPO], rec());
    const e = plan.anchors[0]!;
    expect(e.action).toBe("rebind");
    expect(e.to).toEqual({ node_id: liveId, path: "src/new.py", name: "mod.f", kind: "Function", hash: "h1" });
  });

  it("reports ambiguous on multiple content-hash matches, never guessing", async () => {
    const store = fakeStore({
      getNode: async () => null,
      findByContentHash: async () => [node("rs1:r1:func:a#f@0"), node("rs1:r1:func:b#f@0")],
    });
    const plan = await planReanchor(store, [REPO], rec());
    expect(plan.anchors[0]!.action).toBe("ambiguous");
    expect(plan.anchors[0]!.candidates).toBe(2);
    expect(plan.changed).toBe(false);
    expect(plan.unresolved).toBe(1);
  });

  it("reports orphaned when nothing matches (and when the store lacks findByContentHash)", async () => {
    const plan = await planReanchor(fakeStore({ getNode: async () => null, findByContentHash: async () => [] }), [REPO], rec());
    expect(plan.anchors[0]!.action).toBe("orphaned");
    const noHashLookup = await planReanchor(fakeStore({ getNode: async () => null }), [REPO], rec());
    expect(noHashLookup.anchors[0]!.action).toBe("orphaned");
    expect(noHashLookup.unresolved).toBe(1);
  });
});

describe("applyReanchor", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "reanchor-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rebindStore = (liveId: string) =>
    fakeStore({ getNode: async () => null, findByContentHash: async () => [node(liveId)] });

  it("writes rebinds, stamps reanchored_at + anchor_history, re-signs v2, and never touches prose", async () => {
    const original = rec();
    writeDecision(dir, original);
    const plan = await planReanchor(rebindStore(`rs1:${REPO}:func:src/new.py#f@0`), [REPO], original);
    const updated = applyReanchor(dir, original, plan, "2026-08-23")!;
    const loaded = loadDecisions(dir).decisions[0]!;
    expect(loaded.anchors[0]!.node_id).toBe(`rs1:${REPO}:func:src/new.py#f@0`);
    expect(loaded.reanchored_at).toBe("2026-08-23");
    expect(loaded.anchor_history).toEqual([{ reanchored_at: "2026-08-23", anchors: original.anchors }]);
    expect(loaded.body_hash.startsWith("v2:")).toBe(true);
    expect(verifyBodyHash(loaded)).toBe(true);
    // prose/body untouched — v2 hash core equality is the byte-level proof:
    expect(computeBodyHash(loaded)).toBe(computeBodyHash(original));
    expect(updated.decision).toBe(original.decision);
  });

  it("is a no-op (returns null, writes nothing) when the plan has no rebinds", async () => {
    const original = rec();
    writeDecision(dir, original);
    const plan = await planReanchor(fakeStore({ getNode: async () => null, findByContentHash: async () => [] }), [REPO], original);
    expect(applyReanchor(dir, original, plan, "2026-08-23")).toBeNull();
    const loaded = loadDecisions(dir).decisions[0]!;
    expect(loaded.reanchored_at).toBeUndefined();
    expect(loaded.body_hash).toBe(original.body_hash);
  });

  it("second reanchor after a repair is a no-op (idempotent/deterministic)", async () => {
    const original = rec();
    writeDecision(dir, original);
    const liveId = `rs1:${REPO}:func:src/new.py#f@0`;
    const store = fakeStore({
      getNode: async (_ids, id) => (id === liveId ? node(liveId) : null),
      findByContentHash: async () => [node(liveId)],
    });
    const first = applyReanchor(dir, original, await planReanchor(store, [REPO], original), "2026-08-23")!;
    const second = await planReanchor(store, [REPO], first);
    expect(second.changed).toBe(false);
    expect(applyReanchor(dir, first, second, "2026-08-24")).toBeNull();
  });
});
