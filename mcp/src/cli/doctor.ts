import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureIndexerBinary } from "../indexer/fetchBinary.js";
import { spawnIndexer } from "../indexer/runIndexer.js";
import { resolveRepoId } from "../store/repoId.js";
import { resolveRepoPath } from "../store/resolveRepoPath.js";
import { anchorStateChecks, decisionChecks } from "./doctorDecisions.js";
import { summaryChecks } from "./doctorSummaries.js";
import { hooksCheck, graphStaleCheck } from "./doctorFreshness.js";

export interface DoctorPathResolution {
  path: string;
  /** Set when walk-down found 2+ candidate repos and neither an explicit
   *  path nor REPOSKEIN_REPO_PATH picked one — `path` falls back to `cwd`
   *  in this case so the caller can still print a real (failing) report. */
  error?: string;
}

/** Resolves the repo path for `reposkein-mcp doctor [path]`: explicit arg >
 *  REPOSKEIN_REPO_PATH > walk-up (nearest ancestor with .reposkein/) >
 *  walk-down (workspace mode). Verifies doctor works from a subdirectory
 *  cwd — the common case of running it somewhere other than the repo root. */
export function resolveDoctorRepoPath(
  explicitPath: string | undefined,
  cwd: string,
  envRepoPath: string | undefined
): DoctorPathResolution {
  const resolution = resolveRepoPath({ cwd, envRepoPath, explicit: explicitPath });
  if (resolution.repoPath) return { path: resolution.repoPath };
  if (resolution.candidates && resolution.candidates.length > 0) {
    return {
      path: cwd,
      error:
        `multiple RepoSkein repos found under ${cwd}: ${resolution.candidates.join(", ")}. ` +
        "Pass one explicitly: `reposkein-mcp doctor <path>` (or set REPOSKEIN_REPO_PATH).",
    };
  }
  return { path: cwd };
}

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  critical: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  repoPath: string;
  ok: boolean; // all critical checks pass
  checks: Check[];
}

/** Counts non-empty lines (≈ node count) without parsing every row. */
function countLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim()) n++;
  return n;
}

/** Runs the host-agnostic prerequisite checks for a repo path.
 *  Does NOT check MCP host registration — a CLI can't see that; the
 *  reposkein-setup skill verifies reachability via a probe tool call. */
export async function runChecks(repoPath: string): Promise<DoctorReport> {
  const checks: Check[] = [];

  // 1) Indexer binary present + runnable (critical).
  let binDetail = "";
  let binOk = false;
  try {
    const bin = await ensureIndexerBinary();
    const r = await spawnIndexer(bin, ["--version"]);
    binOk = r.code === 0;
    binDetail = binOk ? (r.stdout.trim() || bin) : (r.stderr.trim() || `exit ${r.code}`);
  } catch (e) {
    binDetail = e instanceof Error ? e.message : String(e);
  }
  checks.push({
    id: "binary",
    label: "indexer binary",
    ok: binOk,
    critical: true,
    detail: binDetail,
    fix: binOk ? undefined : "reinstall @reposkein/mcp, or set REPOSKEIN_INDEXER_BIN to a reposkein-indexer path",
  });

  // 2) Repo indexed: .reposkein/nodes.jsonl exists + has nodes (critical).
  const nodesFile = join(repoPath, ".reposkein", "nodes.jsonl");
  let count = 0;
  const hasIndex = existsSync(nodesFile);
  if (hasIndex) {
    try { count = countLines(readFileSync(nodesFile, "utf8")); } catch { /* unreadable */ }
  }
  const indexedOk = hasIndex && count > 0;
  checks.push({
    id: "indexed",
    label: "repo indexed (.reposkein/nodes.jsonl)",
    ok: indexedOk,
    critical: true,
    detail: indexedOk ? `${count} nodes` : hasIndex ? "nodes.jsonl is empty" : "no .reposkein/nodes.jsonl",
    fix: indexedOk ? undefined : `run \`reposkein-indexer index ${repoPath}\` (or the init_cpg_skeleton MCP tool), then commit .reposkein/`,
  });

  // 3) repo_id resolvable (info — non-critical; helps the user set the env).
  const repoId = resolveRepoId(repoPath, process.env.REPOSKEIN_REPO_ID);
  checks.push({
    id: "repo_id",
    label: "repo id",
    ok: !!repoId,
    critical: false,
    detail: repoId ?? "could not resolve a repo id",
    fix: repoId ? undefined : "set REPOSKEIN_REPO_PATH (or REPOSKEIN_REPO_ID) for the MCP server",
  });

  // 4) Committed summary shards (all non-critical: degrade, don't block).
  checks.push(...summaryChecks(repoPath));

  // 5) Decision log validation (all non-critical: degrade, don't block).
  checks.push(...decisionChecks(repoPath));

  // 5b) Decision anchor drift against the live graph (non-critical, advisory
  //     — never added to CI_FAIL_IDS: reanchoring is a repair step, not a gate).
  checks.push(...(await anchorStateChecks(repoPath, repoId ?? null)));

  // 6) Git hooks installed + graph freshness (non-critical here; `doctor
  //    --ci` promotes both to a failing exit code — see CI_FAIL_IDS below).
  checks.push(hooksCheck(repoPath));
  checks.push(graphStaleCheck(repoPath));

  const ok = checks.filter((c) => c.critical).every((c) => c.ok);
  return { repoPath, ok, checks };
}

/** Check ids that `doctor --ci` treats as build-breaking even though they're
 *  non-critical for interactive use (degrade gracefully for a human at the
 *  keyboard, but should fail a CI job so drift gets caught before it's
 *  merged): missing/foreign git hooks, a stale committed graph, and an
 *  unsplit legacy `summaries.jsonl` (see docs/INSTALL.md §4.2 — every branch
 *  that writes a summary would conflict on it). */
export const CI_FAIL_IDS = new Set(["hooks_installed", "graph_stale", "summaries_unsplit"]);

/** Checks (by id) that `doctor --ci` additionally fails on, beyond the
 *  normal critical-check gate. */
export function ciFailingChecks(report: DoctorReport): Check[] {
  return report.checks.filter((c) => CI_FAIL_IDS.has(c.id) && !c.ok);
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [`reposkein doctor — ${report.repoPath}`, ""];
  for (const c of report.checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.label}: ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`    → ${c.fix}`);
  }
  lines.push("");
  lines.push(report.ok ? "PASS — prerequisites met." : "FAIL — fix the ✗ items above, then re-run `reposkein-mcp doctor`.");
  lines.push("(Note: this checks prerequisites only. To confirm the MCP server is wired into your agent, ask it to call get_context_profile — see the reposkein-setup skill.)");
  return lines.join("\n");
}

export interface RunDoctorOptions {
  json?: boolean;
  /** `doctor --ci`: additionally fail (non-zero exit) when any CI_FAIL_IDS
   *  check is non-ok, even though those checks are non-critical for
   *  interactive use. Doesn't change what's printed — only the exit code. */
  ci?: boolean;
}

/** Entry point for `reposkein-mcp doctor [path] [--json] [--ci]`. Returns the
 *  process exit code. Accepts a bare boolean for `json` for backwards
 *  compatibility with the pre-`--ci` call signature. */
export async function runDoctor(
  repoPath = ".",
  opts: RunDoctorOptions | boolean = {}
): Promise<number> {
  const { json = false, ci = false } = typeof opts === "boolean" ? { json: opts } : opts;
  const report = await runChecks(repoPath);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.error(renderDoctorReport(report));
  const ciFailures = ci ? ciFailingChecks(report) : [];
  if (ci && ciFailures.length > 0 && !json) {
    console.error(
      `\n--ci: failing on ${ciFailures.length} additional check(s): ${ciFailures.map((c) => c.id).join(", ")}`
    );
  }
  return report.ok && ciFailures.length === 0 ? 0 : 1;
}
