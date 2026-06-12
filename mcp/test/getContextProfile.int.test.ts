import { describe, it, expect, beforeAll, afterAll } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import { Neo4jGraphStore } from "../src/store/Neo4jGraphStore.js";
import { resolveTarget } from "../src/profile/resolve.js";
import { setupFixture, REPO } from "./fixture.js";

const gated = process.env.NEO4J_PASSWORD ? describe : describe.skip;

gated("get_context_profile (integration)", () => {
  let store: Neo4jGraphStore;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    cleanup = await setupFixture();
    store = Neo4jGraphStore.fromEnv();
  });
  afterAll(async () => {
    await store.close();
    await cleanup();
  });

  it("resolves a unique name", async () => {
    const r = await resolveTarget(store, REPO, { name: "helper" });
    expect(r.kind).toBe("found");
    if (r.kind === "found") {
      expect(r.target.id).toBe("rs1:proftest:func:base.py#helper@0");
      expect(r.target.file_path).toBe("base.py");
    }
  });

  it("returns not_found for an unknown name", async () => {
    const r = await resolveTarget(store, REPO, { name: "nope" });
    expect(r.kind).toBe("not_found");
  });

  it("assembles upstream/downstream + enrichment for Svc.run", async () => {
    const { assembleProfile } = await import("../src/profile/assemble.js");
    const r = await resolveTarget(store, REPO, { name: "run" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    const profile = await assembleProfile(store, REPO, r.target, 2);

    expect(profile.target.name).toBe("Svc.run");
    // Direct callees: helper + mid.
    const directNames = profile.downstream.filter((d) => d.distance === 1).map((d) => d.name).sort();
    expect(directNames).toEqual(["Svc.mid", "helper"]);
    // No summaries exist yet → everything needs enrichment.
    expect(profile.enrichment_needed).toContain("rs1:proftest:func:base.py#helper@0");
    expect(profile.inlined_context).toMatch(/Calls/);
    // hops=2 reaches nothing new beyond direct here (helper already direct), so
    // downstream has exactly the two direct callees.
    expect(profile.downstream.length).toBe(2);
  });

  it("reports callers in upstream for helper", async () => {
    const { assembleProfile } = await import("../src/profile/assemble.js");
    const r = await resolveTarget(store, REPO, { name: "helper" });
    if (r.kind !== "found") throw new Error("helper not found");
    const profile = await assembleProfile(store, REPO, r.target, 1);
    const callers = profile.upstream.map((u) => u.name).sort();
    expect(callers).toEqual(["Svc.mid", "Svc.run"]);
  });

  it("caps a high-fan-in neighborhood", async () => {
    const FAN_REPO = "fantestcap";
    const targetId = `rs1:${FAN_REPO}:func:target.py#fanTarget@0`;
    let fanDriver: Driver | undefined;

    try {
      fanDriver = neo4j.driver(
        process.env.NEO4J_URI ?? "neo4j://localhost:7687",
        neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD!),
        { disableLosslessIntegers: true }
      );

      const s = fanDriver.session();
      // Clean up any leftover data from previous run.
      await s.run("MATCH (n:Rs {repo_id:$repo}) DETACH DELETE n", { repo: FAN_REPO });

      // Create the target function.
      await s.run(
        "CREATE (t:Rs:Function {id:$id, repo_id:$repo, name:'fanTarget', qualified_name:'fanTarget', file_path:'target.py', start_line:1, end_line:2, content_hash:'hfan'})",
        { id: targetId, repo: FAN_REPO }
      );

      // Create 30 caller functions, each with a CALLS edge to the target.
      for (let i = 0; i < 30; i++) {
        const callerId = `rs1:${FAN_REPO}:func:callers.py#caller${i}@0`;
        await s.run(
          "CREATE (c:Rs:Function {id:$cid, repo_id:$repo, name:$name, qualified_name:$name, file_path:'callers.py', start_line:$line, end_line:$line, content_hash:$hash})" +
          " WITH c MATCH (t:Rs {id:$tid}) CREATE (c)-[:CALLS {resolution:'exact', confidence:1.0, call_sites:1}]->(t)",
          { cid: callerId, repo: FAN_REPO, name: `caller${i}`, line: i + 10, hash: `hc${i}`, tid: targetId }
        );
      }
      await s.close();

      const { assembleProfile } = await import("../src/profile/assemble.js");
      // Resolve the target directly using the store with the fan repo.
      const fanStore = Neo4jGraphStore.fromEnv();
      const r = await resolveTarget(fanStore, FAN_REPO, { name: "fanTarget" });
      expect(r.kind).toBe("found");
      if (r.kind !== "found") return;

      const profile = await assembleProfile(fanStore, FAN_REPO, r.target, 1);
      await fanStore.close();

      expect(profile.upstream.length).toBe(25);
      expect(profile.truncated?.upstream).toBe(true);
      expect(profile.truncated?.downstream).toBe(false);
      expect(profile.inlined_context).toMatch(/more callers not shown/);
    } finally {
      // Clean up the fan-in fixture.
      if (fanDriver) {
        const c = fanDriver.session();
        await c.run("MATCH (n:Rs {repo_id:$repo}) DETACH DELETE n", { repo: FAN_REPO });
        await c.close();
        await fanDriver.close();
      }
    }
  });
});
