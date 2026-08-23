import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBodyHash,
  decisionFileName,
  decisionsDir,
  loadDecisions,
  verifyBodyHash,
  writeDecision,
  type DecisionAnchor,
  type DecisionRecord,
} from "../src/store/decisions.js";
import { runAdrReanchor } from "../src/cli/adrReanchor.js";
import { makeReanchorDecision } from "../src/tools/reanchorDecision.js";
import { anchorStateChecks } from "../src/cli/doctorDecisions.js";
import { JsonlGraphStore } from "../src/store/JsonlGraphStore.js";

const REPO = "scenario";
const TODAY = () => "2026-08-23";

const nodesV1 = [
  `{"id":"rs1:${REPO}:func:src/auth.py#check_token@0","labels":["Function"],"content_hash":"cht","file_path":"src/auth.py","name":"check_token","qualified_name":"check_token","start_line":1,"end_line":9}`,
  `{"id":"rs1:${REPO}:func:src/auth.py#login@0","labels":["Function"],"content_hash":"chl","file_path":"src/auth.py","name":"login","qualified_name":"login","start_line":10,"end_line":20}`,
].join("\n") + "\n";
// The rename: file moved src/auth.py -> src/security/auth.py, ids/paths churn,
// content hashes survive (pure rename) except login also changed content.
const nodesV2 = [
  `{"id":"rs1:${REPO}:func:src/security/auth.py#check_token@0","labels":["Function"],"content_hash":"cht","file_path":"src/security/auth.py","name":"check_token","qualified_name":"check_token","start_line":1,"end_line":9}`,
  `{"id":"rs1:${REPO}:func:src/security/auth.py#login@0","labels":["Function"],"content_hash":"chl2","file_path":"src/security/auth.py","name":"login","qualified_name":"login","start_line":10,"end_line":21}`,
].join("\n") + "\n";

/** Seeds `.reposkein/{meta.json,nodes.jsonl,edges.jsonl}` so resolveRepoId(dir)
 *  === REPO (meta.json's repo_id field, per src/store/repoId.ts) and buildStore
 *  finds a real graph — mirrors test/adrReanchor.test.ts's seedGraph. */
function seedFixture(dir: string, nodes: string): void {
  const reposkein = join(dir, ".reposkein");
  mkdirSync(reposkein, { recursive: true });
  writeFileSync(join(reposkein, "meta.json"), JSON.stringify({ repo_id: REPO }));
  writeFileSync(join(reposkein, "nodes.jsonl"), nodes);
  writeFileSync(join(reposkein, "edges.jsonl"), "");
}

function recFile(dir: string, id: string): string {
  return join(decisionsDir(dir), decisionFileName(id));
}

const CHECK_TOKEN_ID = "adr:2026-08-01-check-token-guard";
const LOGIN_ID = "adr:2026-08-01-login-flow";

function baseRecord(id: string, title: string, anchor: DecisionAnchor, path: string): DecisionRecord {
  const rec: DecisionRecord = {
    id,
    title,
    status: "accepted",
    context: `Context for ${title}.`,
    decision: `We decided about ${title}.`,
    anchors: [anchor],
    paths: [path],
    supersedes: [],
    decided_at: "2026-08-01",
    decided_by: "agent",
    trigger: { kind: "manual" },
    body_hash: "",
  };
  rec.body_hash = computeBodyHash(rec);
  return rec;
}

/** Writes both scenario decisions against `dir`'s current graph state and
 *  returns them. Deterministic content -> deterministic body_hash, so the
 *  same call against two fixtures (dir, dir2) produces byte-identical files. */
function seedDecisions(dir: string): { checkToken: DecisionRecord; login: DecisionRecord } {
  const checkToken = baseRecord(
    CHECK_TOKEN_ID,
    "Guard check_token against replay",
    {
      node_id: `rs1:${REPO}:func:src/auth.py#check_token@0`,
      path: "src/auth.py",
      name: "check_token",
      kind: "Function",
      hash: "cht",
    },
    "src/auth.py"
  );
  const login = baseRecord(
    LOGIN_ID,
    "Rate-limit the login flow",
    {
      node_id: `rs1:${REPO}:func:src/auth.py#login@0`,
      path: "src/auth.py",
      name: "login",
      kind: "Function",
      hash: "chl",
    },
    "src/auth.py"
  );
  writeDecision(dir, checkToken);
  writeDecision(dir, login);
  return { checkToken, login };
}

describe("REP-24 origin scenario: rename -> reanchor -> repaired", () => {
  let dir: string;
  beforeEach(() => {
    dir = mktempScenarioDir();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function mktempScenarioDir(): string {
    const d = mkdtempSync(join(tmpdir(), "reanchor-scenario-"));
    seedFixture(d, nodesV1);
    return d;
  }

  it("repairs renamed anchors in one command; prose byte-identical; partial reported; idempotent", async () => {
    // 1. record two decisions anchored on check_token (pure rename -> repairable)
    //    and login (rename + content change -> orphaned, unrepairable), via
    //    writeDecision with hashes cht / chl and body_hash = computeBodyHash(rec).
    const { checkToken, login } = seedDecisions(dir);
    const checkTokenFile = recFile(dir, checkToken.id);
    const loginFile = recFile(dir, login.id);
    const checkTokenInitialBytes = readFileSync(checkTokenFile, "utf8");
    const loginInitialBytes = readFileSync(loginFile, "utf8");

    // 2. simulate the rename: overwrite nodes.jsonl with nodesV2.
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), nodesV2);

    // 3. dry-run first: exit 1 (login unresolved), files byte-identical before/after.
    const dryRunCode = await runAdrReanchor([dir, "--dry-run"], undefined, { today: TODAY });
    expect(dryRunCode).toBe(1);
    expect(readFileSync(checkTokenFile, "utf8")).toBe(checkTokenInitialBytes);
    expect(readFileSync(loginFile, "utf8")).toBe(loginInitialBytes);

    // 4. real run: exit 1 (partial — login still unresolved).
    const realRunCode = await runAdrReanchor([dir], undefined, { today: TODAY });
    expect(realRunCode).toBe(1);

    //    - check_token decision: anchor now rs1:…:func:src/security/auth.py#check_token@0,
    //      path src/security/auth.py, reanchored_at stamped, anchor_history has the
    //      old anchor, verifyBodyHash true, and computeBodyHash(after) === computeBodyHash(before)
    //      (anchor-independent v2 hash — the "bodies byte-identical" gate), plus direct
    //      field equality on title/context/decision/paths/decided_at/decided_by.
    const afterFirstRun = loadDecisions(dir).decisions;
    const checkTokenAfter = afterFirstRun.find((d) => d.id === checkToken.id)!;
    expect(checkTokenAfter.anchors).toHaveLength(1);
    expect(checkTokenAfter.anchors[0]!.node_id).toBe(
      `rs1:${REPO}:func:src/security/auth.py#check_token@0`
    );
    expect(checkTokenAfter.anchors[0]!.path).toBe("src/security/auth.py");
    expect(checkTokenAfter.reanchored_at).toBe("2026-08-23");
    expect(checkTokenAfter.anchor_history).toBeDefined();
    expect(checkTokenAfter.anchor_history).toHaveLength(1);
    expect(checkTokenAfter.anchor_history![0]!.anchors).toEqual(checkToken.anchors);
    expect(verifyBodyHash(checkTokenAfter)).toBe(true);
    expect(computeBodyHash(checkTokenAfter)).toBe(computeBodyHash(checkToken));
    expect(checkTokenAfter.title).toBe(checkToken.title);
    expect(checkTokenAfter.context).toBe(checkToken.context);
    expect(checkTokenAfter.decision).toBe(checkToken.decision);
    expect(checkTokenAfter.paths).toEqual(checkToken.paths);
    expect(checkTokenAfter.decided_at).toBe(checkToken.decided_at);
    expect(checkTokenAfter.decided_by).toBe(checkToken.decided_by);

    //    - login decision: file bytes IDENTICAL to before the run (orphaned -> untouched).
    expect(readFileSync(loginFile, "utf8")).toBe(loginInitialBytes);
    const loginAfter = afterFirstRun.find((d) => d.id === login.id)!;
    expect(loginAfter.reanchored_at).toBeUndefined();
    expect(loginAfter.anchors).toEqual(login.anchors);

    // 5. doctor: anchorStateChecks now reports ok:false only for login's orphan.
    const checks = await anchorStateChecks(dir, REPO);
    const anchorCheck = checks.find((c) => c.id === "decisions_anchors")!;
    expect(anchorCheck).toBeDefined();
    expect(anchorCheck.ok).toBe(false);
    expect(anchorCheck.detail).toBe("0 moved, 0 stale, 1 orphaned");

    // 6. determinism/idempotence: run again -> exit 1 again, ALL decision files
    //    byte-identical to after step 4 (no history growth, no reanchored_at bump).
    const checkTokenAfterFirstRunBytes = readFileSync(checkTokenFile, "utf8");
    const loginAfterFirstRunBytes = readFileSync(loginFile, "utf8");
    const secondRunCode = await runAdrReanchor([dir], undefined, { today: TODAY });
    expect(secondRunCode).toBe(1);
    expect(readFileSync(checkTokenFile, "utf8")).toBe(checkTokenAfterFirstRunBytes);
    expect(readFileSync(loginFile, "utf8")).toBe(loginAfterFirstRunBytes);
    const afterSecondRun = loadDecisions(dir).decisions;
    const checkTokenAfterSecondRun = afterSecondRun.find((d) => d.id === checkToken.id)!;
    expect(checkTokenAfterSecondRun.anchor_history).toHaveLength(1);
    expect(checkTokenAfterSecondRun.reanchored_at).toBe(checkTokenAfter.reanchored_at);

    // 7. MCP parity: fresh copy of the fixture, same repair via
    //    makeReanchorDecision(new JsonlGraphStore(dir2, REPO), REPO, dir2,
    //    { today: () => "2026-08-23" })({}) — same end state as the CLI run.
    const dir2 = mkdtempSync(join(tmpdir(), "reanchor-scenario-mcp-"));
    try {
      seedFixture(dir2, nodesV1);
      seedDecisions(dir2);
      writeFileSync(join(dir2, ".reposkein", "nodes.jsonl"), nodesV2);

      const store2 = new JsonlGraphStore(dir2, REPO);
      const reanchor = makeReanchorDecision(store2, REPO, dir2, { today: TODAY });
      const res = await reanchor({});
      expect(res.isError).toBeUndefined();
      await store2.close();

      const mcpDecisions = loadDecisions(dir2).decisions;
      const mcpCheckToken = mcpDecisions.find((d) => d.id === checkToken.id)!;
      const mcpLogin = mcpDecisions.find((d) => d.id === login.id)!;

      expect(mcpCheckToken.anchors).toEqual(checkTokenAfter.anchors);
      expect(mcpCheckToken.reanchored_at).toBe(checkTokenAfter.reanchored_at);
      expect(mcpCheckToken.anchor_history).toEqual(checkTokenAfter.anchor_history);
      expect(mcpLogin.anchors).toEqual(loginAfter.anchors);
      expect(mcpLogin.reanchored_at).toBe(loginAfter.reanchored_at);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
