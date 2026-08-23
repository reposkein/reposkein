import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdrReanchor } from "../src/cli/adrReanchor.js";
import {
  computeBodyHash,
  decisionFileName,
  decisionsDir,
  loadDecisions,
  writeDecision,
  type DecisionAnchor,
  type DecisionRecord,
} from "../src/store/decisions.js";

/** `reposkein-mcp adr reanchor` CLI end-to-end (REP-24), against a REAL
 *  JsonlGraphStore (buildStore picks it up from `.reposkein/nodes.jsonl`) and
 *  real decision files on disk — no fakeStore here, planReanchor/applyReanchor
 *  already have unit coverage in test/reanchor.test.ts. */

const REPO_ID = "adr-reanchor-cli-test";

/** Writes `.reposkein/meta.json` (so resolveRepoId/buildStore resolve a real
 *  repo id) + `.reposkein/nodes.jsonl` (row shape per
 *  test/jsonlGraphStore.test.ts). */
function seedGraph(dir: string, nodeLines: string[]): void {
  const reposkein = join(dir, ".reposkein");
  mkdirSync(reposkein, { recursive: true });
  writeFileSync(join(reposkein, "meta.json"), JSON.stringify({ repo_id: REPO_ID }));
  writeFileSync(join(reposkein, "nodes.jsonl"), nodeLines.map((l) => l + "\n").join(""));
}

/** A single Function node row named `f` at `path`. */
function funcNodeLine(path: string, hash: string): string {
  return JSON.stringify({
    id: `rs1:${REPO_ID}:func:${path}#f@0`,
    labels: ["Function"],
    content_hash: hash,
    name: "f",
    qualified_name: "f",
    file_path: path,
    start_line: 1,
    end_line: 2,
  });
}

/** Writes a decision record with one anchor and returns it. */
function seedDecision(dir: string, id: string, anchor: DecisionAnchor): DecisionRecord {
  const rec: DecisionRecord = {
    id,
    title: `Title ${id}`,
    status: "accepted",
    context: "ctx",
    decision: "We decided.",
    anchors: [anchor],
    paths: [],
    supersedes: [],
    decided_at: "2026-08-01",
    decided_by: "agent",
    trigger: { kind: "manual" },
    body_hash: "",
  };
  rec.body_hash = computeBodyHash(rec);
  writeDecision(dir, rec);
  return rec;
}

function recFilePath(dir: string, id: string): string {
  return join(decisionsDir(dir), decisionFileName(id));
}

const today = () => "2026-08-23";

describe("adr reanchor CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adr-reanchor-cli-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("repairs a renamed node and exits 0", async () => {
    seedGraph(dir, [funcNodeLine("src/new.py", "h1")]);
    seedDecision(dir, "adr:2026-08-01-rename", {
      node_id: `rs1:${REPO_ID}:func:src/old.py#f@0`,
      path: "src/old.py",
      name: "f",
      kind: "Function",
      hash: "h1",
    });

    const code = await runAdrReanchor([dir], undefined, { today });

    expect(code).toBe(0);
    const rec = loadDecisions(dir).decisions[0]!;
    expect(rec.anchors[0]!.node_id).toBe(`rs1:${REPO_ID}:func:src/new.py#f@0`);
    expect(rec.anchors[0]!.path).toBe("src/new.py");
    expect(rec.reanchored_at).toBe("2026-08-23");
  });

  it("--dry-run is side-effect-free and still exits 0", async () => {
    seedGraph(dir, [funcNodeLine("src/new.py", "h1")]);
    const id = "adr:2026-08-01-rename";
    seedDecision(dir, id, {
      node_id: `rs1:${REPO_ID}:func:src/old.py#f@0`,
      path: "src/old.py",
      name: "f",
      kind: "Function",
      hash: "h1",
    });
    const recFile = recFilePath(dir, id);
    const before = readFileSync(recFile, "utf8");

    const code = await runAdrReanchor([dir, "--dry-run"], undefined, { today });

    expect(code).toBe(0);
    expect(readFileSync(recFile, "utf8")).toBe(before);
    // loadDecisions confirms the record on disk truly never moved (no
    // reanchored_at stamped), not just that a copy in memory was untouched.
    expect(loadDecisions(dir).decisions[0]!.reanchored_at).toBeUndefined();
  });

  it("exits 1 when unresolved anchors remain, leaving them untouched", async () => {
    seedGraph(dir, [funcNodeLine("src/live.py", "hlive")]);
    const id = "adr:2026-08-01-orphan";
    seedDecision(dir, id, {
      node_id: `rs1:${REPO_ID}:func:src/gone.py#f@0`,
      path: "src/gone.py",
      name: "f",
      kind: "Function",
      hash: "hnomatch",
    });
    const recFile = recFilePath(dir, id);
    const before = readFileSync(recFile, "utf8");

    const code = await runAdrReanchor([dir], undefined, { today });

    expect(code).toBe(1);
    expect(readFileSync(recFile, "utf8")).toBe(before);
  });

  it("--id limits scope and exits 2 on an unknown id", async () => {
    seedGraph(dir, [funcNodeLine("src/new.py", "h1")]);
    seedDecision(dir, "adr:2026-08-01-rename", {
      node_id: `rs1:${REPO_ID}:func:src/old.py#f@0`,
      path: "src/old.py",
      name: "f",
      kind: "Function",
      hash: "h1",
    });

    const code = await runAdrReanchor([dir, "--id", "adr:nope"], undefined, { today });

    expect(code).toBe(2);
  });

  it("--id with no following value exits 2", async () => {
    seedGraph(dir, [funcNodeLine("src/new.py", "h1")]);

    const code = await runAdrReanchor([dir, "--id"], undefined, { today });

    expect(code).toBe(2);
  });

  it("--id scoped to one decision reanchors only that one, leaving a sibling untouched", async () => {
    seedGraph(dir, [funcNodeLine("src/new.py", "h1")]);
    const targetId = "adr:2026-08-01-rename";
    const siblingId = "adr:2026-08-01-orphan";
    seedDecision(dir, targetId, {
      node_id: `rs1:${REPO_ID}:func:src/old.py#f@0`,
      path: "src/old.py",
      name: "f",
      kind: "Function",
      hash: "h1",
    });
    seedDecision(dir, siblingId, {
      node_id: `rs1:${REPO_ID}:func:src/gone.py#f@0`,
      path: "src/gone.py",
      name: "f",
      kind: "Function",
      hash: "hnomatch",
    });
    const siblingFile = recFilePath(dir, siblingId);
    const siblingBefore = readFileSync(siblingFile, "utf8");

    const code = await runAdrReanchor([dir, "--id", targetId], undefined, { today });

    expect(code).toBe(0);
    const { decisions } = loadDecisions(dir);
    expect(decisions.find((d) => d.id === targetId)!.anchors[0]!.path).toBe("src/new.py");
    expect(readFileSync(siblingFile, "utf8")).toBe(siblingBefore);
  });

  it("exits 2 when no graph exists", async () => {
    seedDecision(dir, "adr:2026-08-01-nograph", {
      node_id: `rs1:${REPO_ID}:func:src/x.py#f@0`,
      path: "src/x.py",
      name: "f",
      kind: "Function",
      hash: "h1",
    });

    const code = await runAdrReanchor([dir], undefined, { today });

    expect(code).toBe(2);
  });
});
