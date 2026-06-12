import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
});
