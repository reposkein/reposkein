import { describe, it, expect, beforeAll, afterAll } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import { Neo4jGraphStore } from "../src/store/Neo4jGraphStore.js";
import { makeWriteSemanticSummary } from "../src/tools/writeSemanticSummary.js";

const REPO = "wsstest";
const ID = "rs1:wsstest:func:a.py#f@0";
const gated = process.env.NEO4J_PASSWORD ? describe : describe.skip;

gated("write_semantic_summary (integration)", () => {
  let store: Neo4jGraphStore;
  let driver: Driver;

  beforeAll(async () => {
    store = Neo4jGraphStore.fromEnv();
    driver = neo4j.driver(
      process.env.NEO4J_URI ?? "neo4j://localhost:7687",
      neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD!)
    );
    const s = driver.session();
    await s.run("MATCH (n:Rs {repo_id:$repo}) DETACH DELETE n", { repo: REPO });
    await s.run(
      "CREATE (n:Rs:Function {id:$id, repo_id:$repo, name:'f', content_hash:'H1'})",
      { id: ID, repo: REPO }
    );
    await s.close();
  });
  afterAll(async () => {
    const s = driver.session();
    await s.run("MATCH (n:Rs {repo_id:$repo}) DETACH DELETE n", { repo: REPO });
    await s.close();
    await driver.close();
    await store.close();
  });

  it("writes a summary stamped with the current content_hash", async () => {
    const handler = makeWriteSemanticSummary(store, REPO);
    const res = await handler({ node_id: ID, summary: "Does the thing.", model: "opus" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, stale_replaced: false });

    const rows = await store.runRead(
      "MATCH (n:Rs {id:$id}) RETURN n.semantic_summary AS s, (n.summary_of_hash = n.content_hash) AS fresh, n.summary_model AS m",
      { id: ID }
    );
    expect(rows[0].s).toBe("Does the thing.");
    expect(rows[0].fresh).toBe(true);
    expect(rows[0].m).toBe("opus");
  });

  it("reports stale_replaced when overwriting a summary after a content change", async () => {
    // Simulate the source changing after the summary was written.
    await store.runWrite("MATCH (n:Rs {id:$id}) SET n.content_hash='H2'", { id: ID });
    const handler = makeWriteSemanticSummary(store, REPO);
    const res = await handler({ node_id: ID, summary: "Updated description." });
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, stale_replaced: true });
  });

  it("errors on a missing node", async () => {
    const handler = makeWriteSemanticSummary(store, REPO);
    const res = await handler({ node_id: "rs1:wsstest:func:nope@0", summary: "x" });
    expect(res.isError).toBe(true);
  });
});
