import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks, resolveDoctorRepoPath, runDoctor, ciFailingChecks, CI_FAIL_IDS } from "../src/cli/doctor.js";
import { decisionChecks, anchorStateChecks } from "../src/cli/doctorDecisions.js";
import { graphTrackedCheck } from "../src/cli/doctorFreshness.js";
import { computeBodyHash, writeDecision, decisionsDir, type DecisionRecord } from "../src/store/decisions.js";
import { writeIndexedAtMarker } from "../src/store/indexedAt.js";

// This suite must run hermetically: no network, no dependency on a
// version-matched indexer release asset having been published yet. Without
// this, `runChecks`'s "binary" check falls through
// ensureIndexerBinary -> downloadBinary (GitHub Releases fetch by
// mcp/package.json's version) -> PATH fallback -> `spawn ENOENT`, which is
// exactly what happens on a release-bump commit before the tag's assets are
// live (REP-32), and on any fresh clone with no network/cached binary. Stub
// REPOSKEIN_INDEXER_BIN at a tiny fixture executable that answers
// `--version`/`--schema-version` (and anything else) with exit 0, so the
// "binary" check passes the same way on every machine.
let fixtureDir: string;
let fakeIndexerBin: string;
let savedIndexerBin: string | undefined;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "rs-doctor-fixture-"));
  fakeIndexerBin = join(fixtureDir, "reposkein-indexer");
  writeFileSync(
    fakeIndexerBin,
    "#!/usr/bin/env node\n" +
      "const arg = process.argv[2];\n" +
      'if (arg === "--schema-version") { console.log("1"); }\n' +
      'else { console.log("reposkein-indexer 0.0.0-test"); }\n' +
      "process.exit(0);\n"
  );
  chmodSync(fakeIndexerBin, 0o755);
  savedIndexerBin = process.env.REPOSKEIN_INDEXER_BIN;
  process.env.REPOSKEIN_INDEXER_BIN = fakeIndexerBin;
});

afterAll(() => {
  if (savedIndexerBin === undefined) delete process.env.REPOSKEIN_INDEXER_BIN;
  else process.env.REPOSKEIN_INDEXER_BIN = savedIndexerBin;
  rmSync(fixtureDir, { recursive: true, force: true });
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-doctor-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function gitIn(d: string, args: string[]): void {
  execFileSync("git", ["-C", d, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("resolveDoctorRepoPath", () => {
  it("walks up to the repo root when run from a subdirectory cwd (no path arg)", () => {
    mkdirSync(join(dir, ".reposkein"));
    const sub = join(dir, "src", "nested");
    mkdirSync(sub, { recursive: true });
    const result = resolveDoctorRepoPath(undefined, sub, undefined);
    expect(result).toEqual({ path: dir });
  });

  it("an explicit path argument wins over cwd resolution", () => {
    mkdirSync(join(dir, ".reposkein"));
    const result = resolveDoctorRepoPath("/explicit/path", dir, undefined);
    expect(result).toEqual({ path: "/explicit/path" });
  });

  it("REPOSKEIN_REPO_PATH wins over walk-up", () => {
    mkdirSync(join(dir, ".reposkein"));
    const result = resolveDoctorRepoPath(undefined, dir, "/env/path");
    expect(result).toEqual({ path: "/env/path" });
  });

  it("reports an error naming candidates when the cwd is workspace-ambiguous", () => {
    mkdirSync(join(dir, "repo-a", ".reposkein"), { recursive: true });
    mkdirSync(join(dir, "repo-b", ".reposkein"), { recursive: true });
    const result = resolveDoctorRepoPath(undefined, dir, undefined);
    expect(result.path).toBe(dir);
    expect(result.error).toContain(join(dir, "repo-a"));
    expect(result.error).toContain(join(dir, "repo-b"));
  });
});

describe("doctor runChecks", () => {
  it("flags an unindexed repo (no .reposkein/nodes.jsonl)", async () => {
    const report = await runChecks(dir);
    const indexed = report.checks.find((c) => c.id === "indexed")!;
    expect(indexed.ok).toBe(false);
    expect(report.ok).toBe(false); // 'indexed' is critical
    expect(indexed.fix).toMatch(/index/i);
  });

  it("passes the index check and counts nodes when nodes.jsonl is present", async () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    // two minimal node lines (the check counts lines, not schema)
    writeFileSync(
      join(dir, ".reposkein", "nodes.jsonl"),
      `{"id":"rs1:r:Function:a.py#f@0"}\n{"id":"rs1:r:Function:a.py#g@0"}\n`
    );
    const report = await runChecks(dir);
    const indexed = report.checks.find((c) => c.id === "indexed")!;
    expect(indexed.ok).toBe(true);
    expect(indexed.detail).toMatch(/2 nodes/);
  });
});

function seedDecision(id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const rec: DecisionRecord = {
    id,
    title: `Title ${id}`,
    status: "accepted",
    context: "ctx",
    decision: "We decided.",
    anchors: [],
    paths: [],
    supersedes: [],
    decided_at: id.slice(4, 14),
    decided_by: "agent",
    trigger: { kind: "manual" },
    body_hash: "",
    ...overrides,
  };
  rec.body_hash = computeBodyHash(rec);
  writeDecision(dir, rec);
  return rec;
}

describe("doctor decision checks", () => {
  it("passes cleanly on a healthy decision log (and on no log at all)", () => {
    expect(decisionChecks(dir).every((c) => c.ok)).toBe(true);
    seedDecision("adr:2026-08-01-a");
    seedDecision("adr:2026-08-02-b", { supersedes: ["adr:2026-08-01-a"] });
    const checks = decisionChecks(dir);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.every((c) => !c.critical)).toBe(true); // degrade, don't block
  });

  it("flags a hand-edited body (body_hash mismatch)", () => {
    const rec = seedDecision("adr:2026-08-01-a");
    const tampered = { ...rec, decision: "We decided otherwise." }; // body_hash left stale
    writeFileSync(
      join(decisionsDir(dir), "2026-08-01-a.json"),
      JSON.stringify(tampered) + "\n"
    );
    const integrity = decisionChecks(dir).find((c) => c.id === "decisions_integrity")!;
    expect(integrity.ok).toBe(false);
    expect(integrity.detail).toContain("adr:2026-08-01-a");
  });

  it("flags dangling supersedes references and duplicate ids across files", () => {
    const rec = seedDecision("adr:2026-08-01-a", { supersedes: ["adr:2026-01-01-ghost"] });
    writeFileSync(
      join(decisionsDir(dir), "2026-08-01-a-copy.json"),
      JSON.stringify({ ...rec, status: "proposed" }) + "\n"
    );
    const refs = decisionChecks(dir).find((c) => c.id === "decisions_refs")!;
    expect(refs.ok).toBe(false);
    expect(refs.detail).toContain("adr:2026-01-01-ghost");
    const dupes = decisionChecks(dir).find((c) => c.id === "decisions_duplicates")!;
    expect(dupes.ok).toBe(false);
    expect(dupes.detail).toContain("adr:2026-08-01-a");
  });

  it("flags a supersession cycle and malformed files", () => {
    seedDecision("adr:2026-08-01-a", { supersedes: ["adr:2026-08-02-b"], status: "superseded", superseded_by: "adr:2026-08-02-b" });
    seedDecision("adr:2026-08-02-b", { supersedes: ["adr:2026-08-01-a"] });
    // A decision merely reachable from the cycle members must not be reported
    // as part of the cycle.
    seedDecision("adr:2026-08-03-bystander", { status: "superseded" });
    writeFileSync(join(decisionsDir(dir), "2026-08-04-broken.json"), "<<<<<<< HEAD\n{}\n");
    const checks = decisionChecks(dir);
    const cycles = checks.find((c) => c.id === "decisions_cycles")!;
    expect(cycles.ok).toBe(false);
    expect(cycles.detail).toContain("adr:2026-08-01-a");
    expect(cycles.detail).toContain("adr:2026-08-02-b");
    expect(cycles.detail).not.toContain("bystander");
    expect(checks.find((c) => c.id === "decisions_parse")!.ok).toBe(false);
  });

  it("warns past the active-record budget", () => {
    for (let i = 0; i < 101; i++) {
      seedDecision(`adr:2026-08-01-n${String(i).padStart(3, "0")}`);
    }
    const budget = decisionChecks(dir).find((c) => c.id === "decisions_budget")!;
    expect(budget.ok).toBe(false);
    expect(budget.detail).toMatch(/101/);
  });
});

describe("anchorStateChecks", () => {
  it("returns [] with no graph or no anchored decisions", async () => {
    // No graph at all, but an anchored decision exists.
    seedDecision("adr:2026-08-01-a", {
      anchors: [{ node_id: "rs1:repoa:func:svc.py#f@0", path: "svc.py", name: "f", kind: "Function", hash: "h1" }],
    });
    expect(await anchorStateChecks(dir, "repoa")).toEqual([]);

    // Graph present, but every decision's anchors array is empty.
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(
      join(dir, ".reposkein", "nodes.jsonl"),
      `{"id":"rs1:repoa:func:svc.py#f@0","labels":["Function"],"content_hash":"h1","file_path":"svc.py","name":"f","qualified_name":"f"}\n`
    );
    rmSync(join(decisionsDir(dir), "2026-08-01-a.json"));
    seedDecision("adr:2026-08-02-b"); // no overrides -> anchors: []
    expect(await anchorStateChecks(dir, "repoa")).toEqual([]);
  });

  it("returns [] when repoId is null even though anchors + graph exist", async () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(
      join(dir, ".reposkein", "nodes.jsonl"),
      `{"id":"rs1:repoa:func:svc.py#f@0","labels":["Function"],"content_hash":"h1","file_path":"svc.py","name":"f","qualified_name":"f"}\n`
    );
    seedDecision("adr:2026-08-01-a", {
      anchors: [{ node_id: "rs1:repoa:func:svc.py#f@0", path: "svc.py", name: "f", kind: "Function", hash: "h1" }],
    });
    expect(await anchorStateChecks(dir, null)).toEqual([]);
  });

  it("ok when every anchor is current", async () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(
      join(dir, ".reposkein", "nodes.jsonl"),
      `{"id":"rs1:repoa:func:svc.py#current@0","labels":["Function"],"content_hash":"hash-current","file_path":"svc.py","name":"current","qualified_name":"current"}\n`
    );
    seedDecision("adr:2026-08-01-a", {
      anchors: [
        {
          node_id: "rs1:repoa:func:svc.py#current@0",
          path: "svc.py",
          name: "current",
          kind: "Function",
          hash: "hash-current",
        },
      ],
    });
    const checks = await anchorStateChecks(dir, "repoa");
    const c = checks.find((x) => x.id === "decisions_anchors")!;
    expect(c.ok).toBe(true);
    expect(c.critical).toBe(false);
    expect(c.detail).toBe("all anchors current");
    expect(c.fix).toBeUndefined();
  });

  it("flags moved/stale/orphaned with counts and a reanchor fix", async () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    // Three live nodes: one backs a "current" anchor unchanged, one backs a
    // "stale" anchor (same id, content changed), and one backs a "moved"
    // anchor under a DIFFERENT id but the SAME content_hash (the only signal
    // that survives a rename). No node backs the "orphaned" anchor at all.
    writeFileSync(
      join(dir, ".reposkein", "nodes.jsonl"),
      [
        `{"id":"rs1:repoa:func:svc.py#current@0","labels":["Function"],"content_hash":"hash-current","file_path":"svc.py","name":"current","qualified_name":"current"}`,
        `{"id":"rs1:repoa:func:svc.py#stale@0","labels":["Function"],"content_hash":"hash-stale-new","file_path":"svc.py","name":"stale","qualified_name":"stale"}`,
        `{"id":"rs1:repoa:func:svc.py#movedTarget@0","labels":["Function"],"content_hash":"hash-moved","file_path":"svc.py","name":"movedTarget","qualified_name":"movedTarget"}`,
      ].join("\n") + "\n"
    );
    seedDecision("adr:2026-08-01-a", {
      anchors: [
        {
          node_id: "rs1:repoa:func:svc.py#current@0",
          path: "svc.py",
          name: "current",
          kind: "Function",
          hash: "hash-current",
        },
        {
          node_id: "rs1:repoa:func:svc.py#stale@0",
          path: "svc.py",
          name: "stale",
          kind: "Function",
          hash: "hash-stale-old",
        },
        {
          node_id: "rs1:repoa:func:svc.py#movedOld@0",
          path: "svc.py",
          name: "movedOld",
          kind: "Function",
          hash: "hash-moved",
        },
        {
          node_id: "rs1:repoa:func:svc.py#gone@0",
          path: "svc.py",
          name: "gone",
          kind: "Function",
          hash: "hash-orphan-nomatch",
        },
      ],
    });
    const checks = await anchorStateChecks(dir, "repoa");
    expect(checks).toHaveLength(1);
    const c = checks.find((x) => x.id === "decisions_anchors")!;
    expect(c.ok).toBe(false);
    expect(c.critical).toBe(false);
    expect(c.detail).toMatch(/moved/);
    expect(c.detail).toBe("1 moved, 1 stale, 1 orphaned");
    expect(c.fix).toMatch(/adr reanchor/);
  });
});

function git(args: string[], cwd = dir): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("doctor --ci exit codes", () => {
  it("exits 0 without --ci even with non-critical checks failing (hooks missing, no index)", async () => {
    // No .reposkein/, no .git/hooks — 'indexed' is critical so this repo
    // fails outright; use an indexed-but-hookless repo to isolate the
    // ci-only-failure case instead.
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), `{"id":"rs1:r:Function:a.py#f@0"}\n`);
    const code = await runDoctor(dir, { json: true });
    expect(code).toBe(0); // hooks_installed is non-critical outside --ci
  });

  it("exits non-zero under --ci when hooks are missing, even though the repo is otherwise healthy", async () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), `{"id":"rs1:r:Function:a.py#f@0"}\n`);
    const code = await runDoctor(dir, { json: true, ci: true });
    expect(code).toBe(1);
  });

  it("exits 0 under --ci when hooks are installed, the graph is fresh, and there's no legacy summaries.jsonl", async () => {
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    writeFileSync(join(dir, "a.py"), "def f():\n    return 1\n");
    git(["add", "a.py"]);
    git(["commit", "-qm", "init"]);
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\n# reposkein-managed\nexit 0\n");
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), `{"id":"rs1:r:Function:a.py#f@0"}\n`);
    writeIndexedAtMarker(dir); // records current HEAD as the indexed-at commit
    const code = await runDoctor(dir, { json: true, ci: true });
    expect(code).toBe(0);
  });

  it("accepts a bare boolean for `json` (pre-existing call signature)", async () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), `{"id":"rs1:r:Function:a.py#f@0"}\n`);
    const code = await runDoctor(dir, true);
    expect(code).toBe(0);
  });

  it("ciFailingChecks lists only non-ok CI_FAIL_IDS checks", async () => {
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), `{"id":"rs1:r:Function:a.py#f@0"}\n`);
    const report = await runChecks(dir);
    const failing = ciFailingChecks(report).map((c) => c.id);
    expect(failing).toContain("hooks_installed");
    expect(failing).not.toContain("indexed"); // critical, not a CI_FAIL_IDS member
  });
});

describe("graphTrackedCheck", () => {
  it("fails when the derived graph is committed, and points at migrate", () => {
    gitIn(dir, ["init", "-q"]);
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
    writeFileSync(join(dir, ".reposkein", "edges.jsonl"), '{"src":"n1"}\n');
    gitIn(dir, ["add", ".reposkein"]);
    gitIn(dir, ["commit", "-q", "-m", "track"]);
    const c = graphTrackedCheck(dir);
    expect(c.id).toBe("graph_tracked");
    expect(c.ok).toBe(false);
    expect(c.critical).toBe(false);
    expect(c.fix).toContain("reposkein-mcp migrate");
  });

  it("passes when the graph files are untracked", () => {
    gitIn(dir, ["init", "-q"]);
    mkdirSync(join(dir, ".reposkein"));
    writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), '{"id":"n1"}\n');
    expect(graphTrackedCheck(dir).ok).toBe(true);
  });

  it("skips (ok) outside a git repository", () => {
    mkdirSync(join(dir, ".reposkein"));
    const c = graphTrackedCheck(dir);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("skipped");
  });

  it("is promoted by --ci", () => {
    expect(CI_FAIL_IDS.has("graph_tracked")).toBe(true);
  });
});
