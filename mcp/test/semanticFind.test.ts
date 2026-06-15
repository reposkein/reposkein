import { describe, it, expect } from "vitest";
import { makeSemanticFind } from "../src/tools/semanticFind.js";
import { fakeStore } from "./fakeStore.js";
import type { CorpusNode } from "../src/store/GraphStore.js";

// Helper to build a CorpusNode
const cn = (id: string, qn: string, name: string, kind = "Function", summary = ""): CorpusNode => ({
  id,
  kind,
  name,
  qualified_name: qn,
  signature: "",
  summary,
  file_path: "src/a.ts",
  repo_id: "testrepo",
});

const CORPUS: CorpusNode[] = [
  cn("id:1", "auth.validateToken", "validateToken", "Function", "Validates a JWT auth token"),
  cn("id:2", "billing.charge", "charge", "Function", "Charges a customer card"),
  cn("id:3", "util.toString", "toString", "Function"),
  cn("id:4", "auth.LoginService", "LoginService", "Class", "Service that handles login flows"),
];

function makeStore() {
  return fakeStore({
    searchCorpus: async () => CORPUS,
    federatedRepoIds: async () => [],
  });
}

describe("makeSemanticFind", () => {
  it("returns ranked results for a query, top match first", async () => {
    const handler = makeSemanticFind(makeStore(), "testrepo");
    const result = await handler({ query: "validate token" });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as { text: string }).text) as { results: Array<{ node_id: string; score: number; matched: string[] }> };
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]!.node_id).toBe("id:1");
    expect(body.results[0]!.matched.sort()).toEqual(["token", "validate"]);
  });

  it("is deterministic across two calls", async () => {
    const handler = makeSemanticFind(makeStore(), "testrepo");
    const r1 = await handler({ query: "auth login" });
    const r2 = await handler({ query: "auth login" });
    const ids1 = JSON.parse((r1.content[0] as { text: string }).text).results.map((x: { node_id: string }) => x.node_id);
    const ids2 = JSON.parse((r2.content[0] as { text: string }).text).results.map((x: { node_id: string }) => x.node_id);
    expect(ids1).toEqual(ids2);
  });

  it("respects the limit param (capped at 25)", async () => {
    const handler = makeSemanticFind(makeStore(), "testrepo");
    const result = await handler({ query: "auth", limit: 1 });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.results.length).toBeLessThanOrEqual(1);
  });

  it("caps limit at 25 even if a higher value is passed at handler level", async () => {
    const handler = makeSemanticFind(makeStore(), "testrepo");
    // The schema enforces max(25) via zod but the handler should also guard internally
    const result = await handler({ query: "token", limit: 100 });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.results.length).toBeLessThanOrEqual(25);
  });

  it("filters by kind", async () => {
    const handler = makeSemanticFind(makeStore(), "testrepo");
    const result = await handler({ query: "auth", kind: "Class" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.results.length).toBeGreaterThan(0);
    // Only Class nodes returned
    for (const r of body.results) {
      expect(r.kind).toBe("Class");
    }
  });

  it("returns isError for empty query", async () => {
    const handler = makeSemanticFind(makeStore(), "testrepo");
    const result = await handler({ query: "  " });
    expect(result.isError).toBe(true);
  });

  it("includes summary when present, omits when absent", async () => {
    const handler = makeSemanticFind(makeStore(), "testrepo");
    const result = await handler({ query: "validate token" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    const top = body.results[0];
    // id:1 has a summary
    expect(top.summary).toBeDefined();
    // id:3 toString has no summary — it shouldn't appear in top result but let's check others
    const noSummaryResult = body.results.find((r: { node_id: string; summary?: string }) => r.node_id === "id:3");
    if (noSummaryResult) {
      expect(noSummaryResult.summary).toBeUndefined();
    }
  });

  it("result shape includes node_id, qualified_name, file_path, kind, repo_id, score, matched", async () => {
    const handler = makeSemanticFind(makeStore(), "testrepo");
    const result = await handler({ query: "token" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    const r = body.results[0];
    expect(r).toHaveProperty("node_id");
    expect(r).toHaveProperty("qualified_name");
    expect(r).toHaveProperty("file_path");
    expect(r).toHaveProperty("kind");
    expect(r).toHaveProperty("repo_id");
    expect(r).toHaveProperty("score");
    expect(r).toHaveProperty("matched");
    expect(Array.isArray(r.matched)).toBe(true);
  });
});
