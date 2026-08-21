import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphAvailable, readOnlyUnindexedMessage } from "../src/server/createMcpServer.js";
import { dirtyCheckoutWarning } from "../src/serve/serve.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-guards-"));
  mkdirSync(join(dir, ".reposkein"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("graphAvailable — can we serve reads without building?", () => {
  const nodes = (): void => writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"a"}\n');

  it("false for an unbuilt JSONL repo (the read-only gate's whole purpose)", () => {
    expect(graphAvailable(dir, {})).toBe(false);
    expect(graphAvailable(dir, { REPOSKEIN_STORE: "jsonl" })).toBe(false);
  });

  it("true once nodes.jsonl exists", () => {
    nodes();
    expect(graphAvailable(dir, {})).toBe(true);
    expect(graphAvailable(dir, { REPOSKEIN_STORE: "jsonl" })).toBe(true);
  });

  it("true in explicit neo4j mode — the DB holds the graph, nothing to build", () => {
    expect(graphAvailable(dir, { REPOSKEIN_STORE: "neo4j" })).toBe(true);
  });

  it("true in auto mode with a Neo4j password (mirrors buildStore's fallback)", () => {
    expect(graphAvailable(dir, { NEO4J_PASSWORD: "x" })).toBe(true);
    // …but NOT when jsonl was pinned explicitly: buildStore wouldn't use the DB.
    expect(graphAvailable(dir, { REPOSKEIN_STORE: "jsonl", NEO4J_PASSWORD: "x" })).toBe(false);
  });
});

describe("readOnlyUnindexedMessage", () => {
  it("names the repo, the exact fix, and that nothing changed", () => {
    const msg = readOnlyUnindexedMessage("/srv/repo");
    expect(msg).toContain("/srv/repo");
    expect(msg).toContain("reposkein-mcp index /srv/repo");
    expect(msg).toContain("read-only");
    expect(msg).toContain("Nothing was changed");
  });
});

describe("dirtyCheckoutWarning", () => {
  it("returns null for a clean tree", () => {
    expect(dirtyCheckoutWarning(dir, () => [])).toBeNull();
  });

  it("returns null when git can't answer (not a repo, no git)", () => {
    expect(dirtyCheckoutWarning(dir, () => null)).toBeNull();
  });

  it("warns with a count, a sample, and the deploy-clone recommendation", () => {
    const warning = dirtyCheckoutWarning(dir, () => [" M src/a.ts", "?? scratch.txt"]);
    expect(warning).not.toBeNull();
    expect(warning).toContain("2 uncommitted change(s)");
    expect(warning).toContain("src/a.ts");
    expect(warning).toContain("scratch.txt");
    expect(warning).toContain("DEDICATED DEPLOY CLONE");
    expect(warning).toContain("Serving it anyway");
    expect(warning).toContain("docs/REMOTE.md");
  });

  it("truncates a long status instead of printing hundreds of lines", () => {
    const lines = Array.from({ length: 40 }, (_, i) => ` M src/f${i}.ts`);
    const warning = dirtyCheckoutWarning(dir, () => lines)!;
    expect(warning).toContain("40 uncommitted change(s)");
    expect(warning).toContain("and 35 more");
    expect(warning).not.toContain("src/f39.ts");
  });
});
