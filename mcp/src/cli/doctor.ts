import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureIndexerBinary } from "../indexer/fetchBinary.js";
import { spawnIndexer } from "../indexer/runIndexer.js";
import { resolveRepoId } from "../store/repoId.js";

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

  const ok = checks.filter((c) => c.critical).every((c) => c.ok);
  return { repoPath, ok, checks };
}

function render(report: DoctorReport): string {
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

/** Entry point for `reposkein-mcp doctor [path] [--json]`. Returns process exit code. */
export async function runDoctor(repoPath = ".", json = false): Promise<number> {
  const report = await runChecks(repoPath);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.error(render(report));
  return report.ok ? 0 : 1;
}
