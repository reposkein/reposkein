import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlGraphStore } from "../src/store/JsonlGraphStore.js";
import { CypherUnsupportedError } from "../src/store/GraphStore.js";
import { assertConformance, CONFORMANCE_REPO } from "./storeConformance.js";

const NODES = [
  `{"id":"rs1:proftest:func:base.py#helper@0","labels":["Function"],"content_hash":"hh","end_line":2,"file_path":"base.py","name":"helper","qualified_name":"helper","start_line":1}`,
  `{"id":"rs1:proftest:func:svc.py#Svc.mid@0","labels":["Function"],"content_hash":"hm","end_line":6,"file_path":"svc.py","name":"mid","qualified_name":"Svc.mid","start_line":5}`,
  `{"id":"rs1:proftest:func:svc.py#Svc.run@1","labels":["Function"],"content_hash":"hr","end_line":4,"file_path":"svc.py","name":"run","qualified_name":"Svc.run","start_line":2}`,
].join("\n") + "\n";

const EDGES = [
  `{"from":"rs1:proftest:func:svc.py#Svc.mid@0","type":"CALLS","to":"rs1:proftest:func:base.py#helper@0","call_sites":1,"confidence":1.0,"resolution":"exact"}`,
  `{"from":"rs1:proftest:func:svc.py#Svc.run@1","type":"CALLS","to":"rs1:proftest:func:base.py#helper@0","call_sites":1,"confidence":1.0,"resolution":"exact"}`,
  `{"from":"rs1:proftest:func:svc.py#Svc.run@1","type":"CALLS","to":"rs1:proftest:func:svc.py#Svc.mid@0","call_sites":1,"confidence":1.0,"resolution":"exact"}`,
].join("\n") + "\n";

describe("JsonlGraphStore", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-jsonl-"));
    const dir = join(root, ".reposkein");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nodes.jsonl"), NODES);
    writeFileSync(join(dir, "edges.jsonl"), EDGES);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("satisfies the store conformance contract", async () => {
    const store = new JsonlGraphStore(root, CONFORMANCE_REPO);
    await assertConformance(store);
  });

  it("returns empty/null for a different repo_id", async () => {
    const store = new JsonlGraphStore(root, CONFORMANCE_REPO);
    expect(await store.getNode(["otherrepo"], "rs1:proftest:func:base.py#helper@0")).toBeNull();
    expect(await store.resolveByName(["otherrepo"], "helper")).toEqual([]);
  });

  it("runRead throws CypherUnsupportedError", async () => {
    const store = new JsonlGraphStore(root, CONFORMANCE_REPO);
    await expect(store.runRead()).rejects.toBeInstanceOf(CypherUnsupportedError);
  });

  it("writeSummary marks not_found for a missing node and ok for a real one", async () => {
    const store = new JsonlGraphStore(root, CONFORMANCE_REPO);
    const miss = await store.writeSummary(CONFORMANCE_REPO, "rs1:proftest:func:nope@0", {
      summary: "x",
      model: "m",
      at: "2026-06-12",
      by: "agent",
    });
    expect(miss.kind).toBe("not_found");
    const ok = await store.writeSummary(CONFORMANCE_REPO, "rs1:proftest:func:base.py#helper@0", {
      summary: "Helper does X.",
      model: "m",
      at: "2026-06-12",
      by: "agent",
    });
    expect(ok.kind).toBe("ok");
    if (ok.kind === "ok") expect(ok.stale_replaced).toBe(false);
    // The in-memory write is visible to a subsequent read.
    const node = await store.getNode([CONFORMANCE_REPO], "rs1:proftest:func:base.py#helper@0");
    expect(node?.semantic_summary).toBe("Helper does X.");
  });

  it("persists a summary to the sidecar (durable across a fresh store instance)", async () => {
    const store = new JsonlGraphStore(root, CONFORMANCE_REPO);
    const id = "rs1:proftest:func:base.py#helper@0";
    const res = await store.writeSummary(CONFORMANCE_REPO, id, {
      summary: "Helper does X.",
      model: "opus",
      at: "2026-06-12",
      by: "agent",
    });
    expect(res.kind).toBe("ok");

    // A brand-new store instance (cold load) must see the persisted summary.
    const fresh = new JsonlGraphStore(root, CONFORMANCE_REPO);
    const node = await fresh.getNode([CONFORMANCE_REPO], id);
    expect(node?.semantic_summary).toBe("Helper does X.");
    expect(node?.summary_of_hash).toBe("hh"); // helper's content_hash in the fixture
  });

  it("reloads when the nodes file mtime changes", async () => {
    const store = new JsonlGraphStore(root, CONFORMANCE_REPO);
    const before = await store.resolveByName(CONFORMANCE_REPO, "added");
    expect(before).toEqual([]);
    // Append a new function and bump mtime into the future so the reload triggers.
    const dir = join(root, ".reposkein");
    writeFileSync(
      join(dir, "nodes.jsonl"),
      NODES +
        `{"id":"rs1:proftest:func:svc.py#added@0","labels":["Function"],"content_hash":"ha","end_line":9,"file_path":"svc.py","name":"added","qualified_name":"added","start_line":8}\n`
    );
    const future = Date.now() / 1000 + 10;
    utimesSync(join(dir, "nodes.jsonl"), future, future);
    const after = await store.resolveByName(CONFORMANCE_REPO, "added");
    expect(after).toHaveLength(1);
  });

  it("tags resolved targets and neighbors with repo_id", async () => {
    const store = new JsonlGraphStore(root, CONFORMANCE_REPO);
    const helper = await store.resolveByName([CONFORMANCE_REPO], "helper");
    expect(helper[0]?.repo_id).toBe(CONFORMANCE_REPO);
    const callers = await store.callers([CONFORMANCE_REPO], "rs1:proftest:func:base.py#helper@0", 10);
    expect(callers.every((c) => c.repo_id === CONFORMANCE_REPO)).toBe(true);
    // A repo not in the set yields nothing.
    expect(await store.callers(["otherrepo"], "rs1:proftest:func:base.py#helper@0", 10)).toEqual([]);
  });
});
