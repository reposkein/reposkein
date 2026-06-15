import { expect } from "vitest";
import type { GraphStore } from "../src/store/GraphStore.js";
import { resolveTarget } from "../src/profile/resolve.js";
import { assembleProfile } from "../src/profile/assemble.js";

export const CONFORMANCE_REPO = "proftest";

/** Asserts a GraphStore produces the canonical profile behavior for the
 *  fixture graph (Svc.run -> {helper, Svc.mid}; Svc.mid -> helper). Both the
 *  JSONL and Neo4j stores must pass identically. */
export async function assertConformance(store: GraphStore): Promise<void> {
  const repo = CONFORMANCE_REPO;

  // resolveByName: unique
  const helper = await resolveTarget(store, repo, { name: "helper" });
  expect(helper.kind).toBe("found");
  if (helper.kind === "found") {
    expect(helper.target.id).toBe("rs1:proftest:func:base.py#helper@0");
    expect(helper.target.file_path).toBe("base.py");
  }

  // resolveByName: not found
  expect((await resolveTarget(store, repo, { name: "nope" })).kind).toBe("not_found");

  // assembleProfile for Svc.run: direct callees helper + Svc.mid
  const run = await resolveTarget(store, repo, { name: "run" });
  expect(run.kind).toBe("found");
  if (run.kind === "found") {
    const profile = await assembleProfile(store, repo, run.target, 2);
    expect(profile.target.name).toBe("Svc.run");
    const directNames = profile.downstream
      .filter((d) => d.distance === 1)
      .map((d) => d.name)
      .sort();
    expect(directNames).toEqual(["Svc.mid", "helper"]);
    expect(profile.downstream.length).toBe(2);
    expect(profile.enrichment_needed).toContain("rs1:proftest:func:base.py#helper@0");
  }

  // callers of helper: Svc.mid + Svc.run
  const h = await resolveTarget(store, repo, { name: "helper" });
  if (h.kind === "found") {
    const profile = await assembleProfile(store, repo, h.target, 1);
    expect(profile.upstream.map((u) => u.name).sort()).toEqual(["Svc.mid", "Svc.run"]);
  }

  // searchCorpus: returns all Function nodes for the repo, sorted by id
  const corpus = await store.searchCorpus([repo]);
  expect(corpus.length).toBeGreaterThanOrEqual(3);
  // all returned nodes must be from the correct repo
  expect(corpus.every((c) => c.repo_id === repo)).toBe(true);
  // all must be Function/Class/Interface/Enum
  const VALID_KINDS = new Set(["Function", "Class", "Interface", "Enum"]);
  expect(corpus.every((c) => VALID_KINDS.has(c.kind))).toBe(true);
  // sorted ascending by id
  for (let i = 1; i < corpus.length; i++) {
    expect(corpus[i]!.id >= corpus[i - 1]!.id).toBe(true);
  }
  // helper node must appear
  const helperNode = corpus.find((c) => c.name === "helper");
  expect(helperNode).toBeDefined();
  expect(helperNode?.kind).toBe("Function");
}
