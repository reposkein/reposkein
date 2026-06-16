import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlGraphStore } from "../src/store/JsonlGraphStore.js";
import { resolveTarget } from "../src/profile/resolve.js";
import { assembleProfile } from "../src/profile/assemble.js";
import { federationIds } from "../src/store/federation.js";

const ROOT = "jfRoot";
const CHILD = "jfChild";

describe("JsonlGraphStore federation (cross-repo)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rs-jfed-"));
    // Root repo: caller with external_calls + a Repository proxy to the child.
    const rdir = join(root, ".reposkein");
    mkdirSync(rdir, { recursive: true });
    writeFileSync(
      join(rdir, "nodes.jsonl"),
      [
        `{"id":"rs1:jfRoot:func:a.py#caller@0","labels":["Function"],"name":"caller","qualified_name":"caller","file_path":"a.py","start_line":1,"end_line":2,"content_hash":"hc","external_calls":["target"]}`,
        `{"id":"rs1:jfRoot:repo:.","labels":["Repository"],"root_path":".","is_nested":false}`,
        `{"id":"rs1:jfRoot:repo:vendor/b","labels":["Repository"],"root_path":"vendor/b","is_nested":true,"federated_repo_id":"jfChild"}`,
      ].join("\n") + "\n"
    );
    writeFileSync(join(rdir, "edges.jsonl"), "");
    // Child repo at vendor/b: defines target.
    const cdir = join(root, "vendor", "b", ".reposkein");
    mkdirSync(cdir, { recursive: true });
    writeFileSync(
      join(cdir, "nodes.jsonl"),
      `{"id":"rs1:jfChild:func:b.py#target@0","labels":["Function"],"name":"target","qualified_name":"target","file_path":"b.py","start_line":1,"end_line":2,"content_hash":"ht"}` + "\n"
    );
    writeFileSync(join(cdir, "edges.jsonl"), "");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("non-federated resolution does NOT find a child-repo symbol", async () => {
    const store = new JsonlGraphStore(root, ROOT);
    expect((await resolveTarget(store, [ROOT], { name: "target" })).kind).toBe("not_found");
  });

  it("federated resolution finds the child symbol tagged with its repo_id", async () => {
    const store = new JsonlGraphStore(root, ROOT);
    const r = await resolveTarget(store, [ROOT, CHILD], { name: "target" });
    expect(r.kind).toBe("found");
    if (r.kind === "found") {
      expect(r.target.id).toBe("rs1:jfChild:func:b.py#target@0");
      expect(r.target.repo_id).toBe(CHILD);
    }
  });

  it("federated profile surfaces the cross-repo callee (cross_repo + name_match)", async () => {
    const store = new JsonlGraphStore(root, ROOT);
    const caller = await resolveTarget(store, [ROOT], { name: "caller" });
    if (caller.kind !== "found") throw new Error("caller not found");

    const solo = await assembleProfile(store, [ROOT], caller.target, 1);
    expect(solo.downstream.length).toBe(0);

    const fed = await assembleProfile(store, [ROOT, CHILD], caller.target, 1);
    const t = fed.downstream.find((d) => d.name === "target");
    expect(t).toBeTruthy();
    expect(t!.repo_id).toBe(CHILD);
    expect(t!.cross_repo).toBe(true);
    expect(t!.resolution).toBe("name_match");
    expect(fed.inlined_context).toContain(`[repo: ${CHILD}]`);
  });
});

// ——— 3-level federation: root → child → grandchild ———

const ROOT3 = "jf3Root";
const CHILD3 = "jf3Child";
const GRANDCHILD3 = "jf3Grand";

describe("JsonlGraphStore federation — 3-level (root → child → grandchild)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rs-jfed3-"));

    // Root repo: a Repository proxy pointing to the child.
    const rdir = join(root, ".reposkein");
    mkdirSync(rdir, { recursive: true });
    writeFileSync(
      join(rdir, "nodes.jsonl"),
      [
        `{"id":"rs1:${ROOT3}:repo:.","labels":["Repository"],"root_path":".","is_nested":false}`,
        `{"id":"rs1:${ROOT3}:repo:vendor/c","labels":["Repository"],"root_path":"vendor/c","is_nested":true,"federated_repo_id":"${CHILD3}"}`,
      ].join("\n") + "\n"
    );
    writeFileSync(join(rdir, "edges.jsonl"), "");

    // Child repo at vendor/c: its own proxy pointing to the grandchild.
    const cdir = join(root, "vendor", "c", ".reposkein");
    mkdirSync(cdir, { recursive: true });
    writeFileSync(
      join(cdir, "nodes.jsonl"),
      [
        `{"id":"rs1:${CHILD3}:func:c.py#childFn@0","labels":["Function"],"name":"childFn","qualified_name":"childFn","file_path":"c.py","start_line":1,"end_line":2,"content_hash":"hcf"}`,
        `{"id":"rs1:${CHILD3}:repo:.","labels":["Repository"],"root_path":".","is_nested":false}`,
        `{"id":"rs1:${CHILD3}:repo:vendor/d","labels":["Repository"],"root_path":"vendor/d","is_nested":true,"federated_repo_id":"${GRANDCHILD3}"}`,
      ].join("\n") + "\n"
    );
    writeFileSync(join(cdir, "edges.jsonl"), "");

    // Grandchild repo at vendor/c/vendor/d: defines grandFn.
    const gdir = join(root, "vendor", "c", "vendor", "d", ".reposkein");
    mkdirSync(gdir, { recursive: true });
    writeFileSync(
      join(gdir, "nodes.jsonl"),
      `{"id":"rs1:${GRANDCHILD3}:func:d.py#grandFn@0","labels":["Function"],"name":"grandFn","qualified_name":"grandFn","file_path":"d.py","start_line":1,"end_line":2,"content_hash":"hgf"}` + "\n"
    );
    writeFileSync(join(gdir, "edges.jsonl"), "");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("federatedRepoIds includes the grandchild repo_id (transitive, not just direct)", async () => {
    const store = new JsonlGraphStore(root, ROOT3);
    const ids = await store.federatedRepoIds(ROOT3);
    expect(ids).toContain(CHILD3);
    expect(ids).toContain(GRANDCHILD3);
    expect(ids).not.toContain(ROOT3); // root excluded from the federated set
  });

  it("federationIds (used by tools) includes root + child + grandchild", async () => {
    const store = new JsonlGraphStore(root, ROOT3);
    const allIds = await federationIds(store, ROOT3);
    expect(allIds).toContain(ROOT3);
    expect(allIds).toContain(CHILD3);
    expect(allIds).toContain(GRANDCHILD3);
  });

  it("a federated read surfaces a grandchild node", async () => {
    const store = new JsonlGraphStore(root, ROOT3);
    const allIds = await federationIds(store, ROOT3);
    const r = await resolveTarget(store, allIds, { name: "grandFn" });
    expect(r.kind).toBe("found");
    if (r.kind === "found") {
      expect(r.target.id).toBe(`rs1:${GRANDCHILD3}:func:d.py#grandFn@0`);
      expect(r.target.repo_id).toBe(GRANDCHILD3);
    }
  });
});
