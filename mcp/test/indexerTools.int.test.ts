import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import neo4j, { type Driver } from "neo4j-driver";
import { makeInitCpgSkeleton } from "../src/tools/indexerTools.js";

const INDEXER = "/Users/mjnong/repos/reposkein/indexer/target/debug/reposkein-indexer";
const REPO = "inittest";
const gated = process.env.NEO4J_PASSWORD ? describe : describe.skip;

gated("init_cpg_skeleton (integration)", () => {
  let dir: string;
  let driver: Driver;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rs-init-"));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "base.py"), "def helper():\n    return 1\n");
    writeFileSync(join(dir, "app", "svc.py"), "from app.base import helper\n\ndef run():\n    return helper()\n");
    process.env.REPOSKEIN_INDEXER_BIN = INDEXER;
    process.env.REPOSKEIN_REPO_PATH = dir;
    driver = neo4j.driver(
      process.env.NEO4J_URI ?? "neo4j://localhost:7687",
      neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD!)
    );
  });

  afterAll(async () => {
    const s = driver.session();
    await s.run("MATCH (n:Rs {repo_id:$repo}) DETACH DELETE n", { repo: REPO });
    await s.close();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes a repo and loads it into Neo4j", async () => {
    const init = makeInitCpgSkeleton(REPO);
    const res = await init({});
    const payload = JSON.parse(res.content[0].text);
    expect(res.isError).toBeFalsy();
    expect(payload.ok).toBe(true);
    expect(payload.nodes).toBeGreaterThan(0);

    // The data is queryable in Neo4j under REPO.
    const s = driver.session({ defaultAccessMode: neo4j.session.READ });
    const r = await s.run(
      "MATCH (n:Function {repo_id:$repo}) RETURN count(n) AS c",
      { repo: REPO }
    );
    await s.close();
    expect(r.records[0].get("c").toNumber()).toBeGreaterThan(0);
  });
});
