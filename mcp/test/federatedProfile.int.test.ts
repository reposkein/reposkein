import { describe, it, expect, beforeAll, afterAll } from "vitest";
import neo4j, { type Driver } from "neo4j-driver";
import { Neo4jGraphStore } from "../src/store/Neo4jGraphStore.js";
import { resolveTarget } from "../src/profile/resolve.js";
import { assembleProfile } from "../src/profile/assemble.js";

const gated = process.env.NEO4J_PASSWORD ? describe : describe.skip;
const ROOT = "fedAtest";
const CHILD = "fedBtest";

gated("federated get_context_profile (Neo4j, 2 repos)", () => {
  let store: Neo4jGraphStore;
  let driver: Driver;

  beforeAll(async () => {
    driver = neo4j.driver(
      process.env.NEO4J_URI ?? "neo4j://localhost:7687",
      neo4j.auth.basic(process.env.NEO4J_USER ?? "neo4j", process.env.NEO4J_PASSWORD!),
      { disableLosslessIntegers: true }
    );
    const s = driver.session();
    await s.run("MATCH (n:Rs) WHERE n.repo_id IN $r DETACH DELETE n", { r: [ROOT, CHILD] });
    // Root repo: a caller function + a root Repository node + a proxy to the child.
    await s.run(
      `CREATE (c:Rs:Function {id:'rs1:fedAtest:func:a.py#caller@0', repo_id:$root, name:'caller', qualified_name:'caller', file_path:'a.py', start_line:1, end_line:2, content_hash:'hc'})
       CREATE (rr:Rs:Repository {id:'rs1:fedAtest:repo:.', repo_id:$root, root_path:'.', is_nested:false})
       CREATE (px:Rs:Repository {id:'rs1:fedAtest:repo:vendor/b', repo_id:$root, root_path:'vendor/b', is_nested:true, federated_repo_id:$child})
       CREATE (rr)-[:FEDERATES_TO]->(px)`,
      { root: ROOT, child: CHILD }
    );
    // Child repo: a target function.
    await s.run(
      `CREATE (t:Rs:Function {id:'rs1:fedBtest:func:b.py#target@0', repo_id:$child, name:'target', qualified_name:'target', file_path:'b.py', start_line:1, end_line:2, content_hash:'ht'})`,
      { child: CHILD }
    );
    // Hand-built CROSS-REPO CALLS edge (the indexer does not emit these yet;
    // this proves the federated traversal mechanism).
    await s.run(
      `MATCH (c:Rs {id:'rs1:fedAtest:func:a.py#caller@0'}), (t:Rs {id:'rs1:fedBtest:func:b.py#target@0'})
       CREATE (c)-[:CALLS {resolution:'exact', confidence:1.0, call_sites:1}]->(t)`
    );
    await s.close();
    store = Neo4jGraphStore.fromEnv();
  });

  afterAll(async () => {
    const s = driver.session();
    await s.run("MATCH (n:Rs) WHERE n.repo_id IN $r DETACH DELETE n", { r: [ROOT, CHILD] });
    await s.close();
    await driver.close();
    await store.close();
  });

  it("non-federated resolution does NOT find a child-repo symbol", async () => {
    const r = await resolveTarget(store, [ROOT], { name: "target" });
    expect(r.kind).toBe("not_found");
  });

  it("federated resolution finds the child-repo symbol, tagged with its repo_id", async () => {
    const r = await resolveTarget(store, [ROOT, CHILD], { name: "target" });
    expect(r.kind).toBe("found");
    if (r.kind === "found") {
      expect(r.target.id).toBe("rs1:fedBtest:func:b.py#target@0");
      expect(r.target.repo_id).toBe(CHILD);
    }
  });

  it("federated profile surfaces the cross-repo callee with annotation", async () => {
    const caller = await resolveTarget(store, [ROOT], { name: "caller" });
    expect(caller.kind).toBe("found");
    if (caller.kind !== "found") return;

    // Non-federated: no cross-repo callee.
    const solo = await assembleProfile(store, [ROOT], caller.target, 1);
    expect(solo.downstream.length).toBe(0);

    // Federated: the child-repo callee appears, tagged + annotated.
    const fed = await assembleProfile(store, [ROOT, CHILD], caller.target, 1);
    expect(fed.downstream.map((d) => d.name)).toContain("target");
    const t = fed.downstream.find((d) => d.name === "target")!;
    expect(t.repo_id).toBe(CHILD);
    expect(fed.inlined_context).toContain(`[repo: ${CHILD}]`);
  });
});
