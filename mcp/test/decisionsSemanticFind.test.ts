import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeStore } from "./fakeStore.js";
import type { CorpusNode } from "../src/store/GraphStore.js";
import { computeBodyHash, writeDecision, type DecisionRecord } from "../src/store/decisions.js";
import { makeSemanticFind } from "../src/tools/semanticFind.js";

const REPO_ID = "abc123";

const FN: CorpusNode = {
  id: `rs1:${REPO_ID}:func:pay.py#charge@1`,
  kind: "Function",
  name: "charge",
  qualified_name: "Billing.charge",
  signature: "def charge(amount)",
  summary: "Charges the customer.",
  file_path: "pay.py",
  repo_id: REPO_ID,
};

function seed(root: string, id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const rec: DecisionRecord = {
    id,
    title: "Use idempotency keys for payment retries",
    status: "accepted",
    context: "Duplicate charges happened on network retries.",
    decision: "Every charge call carries an idempotency key.",
    anchors: [],
    paths: ["pay/"],
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

function parse(res: { content: { text: string }[] }): { results: Record<string, unknown>[] } {
  return JSON.parse(res.content[0]!.text) as { results: Record<string, unknown>[] };
}

describe("semantic_find over decisions", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rs-semfind-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("ranks decision records for queries matching their rationale", async () => {
    seed(root, "adr:2026-08-10-idempotency");
    const store = fakeStore({ searchCorpus: async () => [FN] });
    const find = makeSemanticFind(store, REPO_ID, root, null);
    const out = parse(await find({ query: "idempotency retries duplicate charges" }));
    const decision = out.results.find((r) => r.kind === "Decision");
    expect(decision).toBeDefined();
    expect(decision!.node_id).toBe("adr:2026-08-10-idempotency");
    expect(decision!.status).toBe("accepted");
    expect(decision!.file_path).toBe("pay/");
  });

  it("kind filter isolates or excludes decisions", async () => {
    seed(root, "adr:2026-08-10-idempotency");
    const store = fakeStore({ searchCorpus: async () => [FN] });
    const find = makeSemanticFind(store, REPO_ID, root, null);
    const onlyDecisions = parse(await find({ query: "charge", kind: "Decision" }));
    expect(onlyDecisions.results.every((r) => r.kind === "Decision")).toBe(true);
    expect(onlyDecisions.results.length).toBe(1);
    const onlyFns = parse(await find({ query: "charge", kind: "Function" }));
    expect(onlyFns.results.every((r) => r.kind === "Function")).toBe(true);
  });

  it("works with no decision log present (pure code corpus)", async () => {
    const store = fakeStore({ searchCorpus: async () => [FN] });
    const find = makeSemanticFind(store, REPO_ID, root, null);
    const out = parse(await find({ query: "charge" }));
    expect(out.results[0]!.node_id).toBe(FN.id);
  });
});
