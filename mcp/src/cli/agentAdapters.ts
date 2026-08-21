/** Per-agent MCP config adapters for `reposkein-mcp init`'s join mode
 *  (REP-16 T5). A "join" is: someone cloned a repo that already has RepoSkein
 *  set up (committed `.reposkein/meta.json`) — the one thing left to do is
 *  wire the local agent(s) up, which today means hand-copying a JSON snippet
 *  from docs/INSTALL.md §6. These adapters do that automatically.
 *
 *  Schemas match docs/INSTALL.md §6 exactly — that doc is the spec:
 *   - Claude Code: `<repo>/.mcp.json`, `mcpServers` key. Prefers `claude mcp
 *     add` (scope "project", which itself targets .mcp.json) when the CLI is
 *     on PATH, so Claude's own approval/health-check flow sees the entry;
 *     falls back to writing the file directly.
 *   - OpenCode (+omo): `<repo>/opencode.json`, `mcp` key (NOT `mcpServers`).
 *   - Cursor: `<repo>/.cursor/mcp.json`, `mcpServers` key.
 *   - Unknown/no agent detected: falls back to `.mcp.json` (§6.6 "generic").
 *
 *  Every write is idempotent (re-run = no-op, byte-identical file), dry-run
 *  aware (never touches disk when `dryRun: true`), and backs up any file it
 *  actually modifies to a timestamped `.bak` sibling first. */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

export type AgentId = "claude" | "opencode" | "cursor";
export const ALL_AGENT_IDS: readonly AgentId[] = ["claude", "opencode", "cursor"];

export type AdapterAction = "created" | "updated" | "unchanged" | "dry-run" | "error";

export interface AdapterResult {
  agent: AgentId;
  /** File this adapter wrote (or would write). For the "claude" adapter via
   *  the CLI this is still `.mcp.json` — `claude mcp add -s project` writes
   *  there under the hood. */
  path: string;
  action: AdapterAction;
  /** Set only when an existing file was actually modified. */
  backupPath?: string;
  message: string;
}

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Injectable command runner — never throws (unlike execFileSync). Tests
 *  inject a fake to avoid shelling out to a real `claude`/`opencode` CLI or
 *  mutating a real project's MCP config. */
export type Exec = (cmd: string, args: string[], opts: { cwd: string }) => ExecResult;

export const defaultExec: Exec = (cmd, args, opts) => {
  try {
    const stdout = execFileSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout ? e.stdout.toString() : "",
      stderr: e.stderr ? e.stderr.toString() : String(e.message ?? err),
    };
  }
};

function commandAvailable(exec: Exec, cmd: string, cwd: string): boolean {
  return exec(cmd, ["--version"], { cwd }).status === 0;
}

/** Detects which agents are "present": their CLI is on PATH, or their config
 *  file already exists (someone opted in previously — keep writing there).
 *  Falls back to `["claude"]` (→ `.mcp.json`, the generic/broadest-compat
 *  target) when nothing is detected at all, matching docs/INSTALL.md §6.6. */
export function detectAgents(repoPath: string, exec: Exec = defaultExec): AgentId[] {
  const present: AgentId[] = [];
  if (existsSync(join(repoPath, ".mcp.json")) || commandAvailable(exec, "claude", repoPath)) present.push("claude");
  if (existsSync(join(repoPath, "opencode.json")) || commandAvailable(exec, "opencode", repoPath)) present.push("opencode");
  if (existsSync(join(repoPath, ".cursor"))) present.push("cursor");
  if (present.length === 0) present.push("claude");
  return present;
}

/** Parses a comma/space-separated `--agents` value into AgentId[], ignoring
 *  unknown tokens (never throws — an unrecognized agent name just writes
 *  nothing rather than crashing `init`). */
export function parseAgentsFlag(value: string): AgentId[] {
  const known = new Set<string>(ALL_AGENT_IDS);
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AgentId => known.has(s));
}

function timestampSuffix(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Copies `path` to `<path>.<timestamp>.bak` before it's modified. */
function backupFile(path: string, now: Date): string {
  const backupPath = `${path}.${timestampSuffix(now)}.bak`;
  copyFileSync(path, backupPath);
  return backupPath;
}

interface JsonAdapterSpec {
  /** Relative to repoPath. */
  relPath: string;
  topKey: "mcpServers" | "mcp";
  buildEntry: (absRepoPath: string) => unknown;
}

const MCP_JSON_SPEC: JsonAdapterSpec = {
  relPath: ".mcp.json",
  topKey: "mcpServers",
  buildEntry: (absRepoPath) => ({ command: "reposkein-mcp", env: { REPOSKEIN_REPO_PATH: absRepoPath } }),
};

const OPENCODE_JSON_SPEC: JsonAdapterSpec = {
  relPath: "opencode.json",
  topKey: "mcp",
  buildEntry: (absRepoPath) => ({
    type: "local",
    command: ["reposkein-mcp"],
    environment: { REPOSKEIN_REPO_PATH: absRepoPath },
    enabled: true,
  }),
};

const CURSOR_JSON_SPEC: JsonAdapterSpec = {
  relPath: join(".cursor", "mcp.json"),
  topKey: "mcpServers",
  buildEntry: (absRepoPath) => ({ command: "reposkein-mcp", env: { REPOSKEIN_REPO_PATH: absRepoPath } }),
};

/** Idempotently upserts `doc[topKey].reposkein = entry` in a JSON config
 *  file, preserving every other key untouched (other MCP servers, `$schema`,
 *  etc.). Unparseable existing JSON is treated as empty (still backed up
 *  before being overwritten) rather than crashing `init`. */
function upsertJsonAdapter(
  repoPath: string,
  spec: JsonAdapterSpec,
  dryRun: boolean,
  now: Date
): { path: string; action: AdapterAction; backupPath?: string; message: string } {
  const path = join(repoPath, spec.relPath);
  const exists = existsSync(path);
  let doc: Record<string, unknown> = {};
  if (exists) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      doc = {}; // corrupt/hand-edited JSON — don't guess; overwrite (after backup)
    }
  }
  const section = (doc[spec.topKey] as Record<string, unknown> | undefined) ?? {};
  const entry = spec.buildEntry(resolve(repoPath));
  if (JSON.stringify(section.reposkein ?? null) === JSON.stringify(entry)) {
    return { path, action: "unchanged", message: `${spec.relPath} already has an up-to-date reposkein entry` };
  }
  if (dryRun) {
    return {
      path,
      action: "dry-run",
      message: `would ${exists ? "update" : "create"} ${spec.relPath} (${spec.topKey}.reposkein)`,
    };
  }
  let backupPath: string | undefined;
  if (exists) backupPath = backupFile(path, now);
  doc[spec.topKey] = { ...section, reposkein: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return { path, action: exists ? "updated" : "created", backupPath, message: `${exists ? "updated" : "created"} ${spec.relPath}` };
}

function claudeCliEntryExists(exec: Exec, repoPath: string): boolean {
  return exec("claude", ["mcp", "get", "reposkein"], { cwd: repoPath }).status === 0;
}

/** Writes the Claude Code entry via `claude mcp add -s project` (which
 *  itself targets `.mcp.json`), so Claude's own health-check/approval UI
 *  picks it up immediately. Idempotent via `claude mcp get` — a re-run
 *  no-ops instead of erroring on a duplicate name. */
function writeViaClaudeCli(repoPath: string, dryRun: boolean, exec: Exec): AdapterResult {
  const path = join(repoPath, ".mcp.json");
  if (claudeCliEntryExists(exec, repoPath)) {
    return { agent: "claude", path, action: "unchanged", message: "`claude mcp get reposkein` already resolves — nothing to add" };
  }
  const args = ["mcp", "add", "reposkein", "-s", "project", "-e", `REPOSKEIN_REPO_PATH=${resolve(repoPath)}`, "--", "reposkein-mcp"];
  if (dryRun) {
    return { agent: "claude", path, action: "dry-run", message: `would run: claude ${args.join(" ")}` };
  }
  const r = exec("claude", args, { cwd: repoPath });
  if (r.status !== 0) {
    return { agent: "claude", path, action: "error", message: `claude mcp add failed: ${(r.stderr || r.stdout).trim()}` };
  }
  return { agent: "claude", path, action: "created", message: "added via `claude mcp add` (project scope → .mcp.json)" };
}

export interface WriteAgentConfigsOptions {
  /** Explicit `--agents` override — write exactly these, skipping detection. */
  agents?: AgentId[];
  dryRun?: boolean;
  /** Injectable for tests. */
  exec?: Exec;
  now?: () => Date;
}

/** Writes (or plans, under `dryRun`) the local agent MCP config for every
 *  detected/requested agent. Pure w.r.t. its inputs beyond `exec`/`now`/fs —
 *  same repo state + same options always produces the same plan, which is
 *  what makes idempotence and dry-run trustworthy. */
export function writeAgentConfigs(repoPath: string, opts: WriteAgentConfigsOptions = {}): AdapterResult[] {
  const exec = opts.exec ?? defaultExec;
  const now = (opts.now ?? (() => new Date()))();
  const dryRun = !!opts.dryRun;
  const agents = opts.agents ?? detectAgents(repoPath, exec);

  const results: AdapterResult[] = [];
  for (const agent of agents) {
    if (agent === "claude") {
      if (commandAvailable(exec, "claude", repoPath)) {
        results.push(writeViaClaudeCli(repoPath, dryRun, exec));
      } else {
        const r = upsertJsonAdapter(repoPath, MCP_JSON_SPEC, dryRun, now);
        results.push({ agent: "claude", ...r });
      }
    } else if (agent === "opencode") {
      const r = upsertJsonAdapter(repoPath, OPENCODE_JSON_SPEC, dryRun, now);
      results.push({ agent: "opencode", ...r });
    } else if (agent === "cursor") {
      const r = upsertJsonAdapter(repoPath, CURSOR_JSON_SPEC, dryRun, now);
      results.push({ agent: "cursor", ...r });
    }
  }
  return results;
}

/** One line per adapter result, for `init`'s stderr summary. */
export function formatAdapterResult(r: AdapterResult): string {
  const verb =
    r.action === "created" ? "wrote" :
    r.action === "updated" ? "updated" :
    r.action === "unchanged" ? "unchanged" :
    r.action === "dry-run" ? "[dry-run]" :
    "ERROR";
  const backup = r.backupPath ? ` (backup: ${r.backupPath})` : "";
  return `reposkein: [${r.agent}] ${verb} — ${r.message}${backup}`;
}
