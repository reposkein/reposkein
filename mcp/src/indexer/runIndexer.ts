import { spawn } from "node:child_process";

const ALLOWED_KEYS = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"]);

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ALLOWED_KEYS.has(k) || k.startsWith("REPOSKEIN_")) {
      env[k] = v;
    }
  }
  return env;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Path to the indexer binary: REPOSKEIN_INDEXER_BIN or `reposkein-indexer`.
 * @deprecated Superseded by ensureIndexerBinary() in fetchBinary.ts (M4-D1).
 *             Kept for back-compat; prefer ensureIndexerBinary() in new code. */
export function indexerBinPath(): string {
  return process.env.REPOSKEIN_INDEXER_BIN ?? "reposkein-indexer";
}

/** Repo root the indexer operates on: REPOSKEIN_REPO_PATH or cwd. */
export function repoPath(): string {
  return process.env.REPOSKEIN_REPO_PATH ?? process.cwd();
}

export function spawnIndexer(bin: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: buildChildEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export interface IndexJsonStats {
  repo_id: string;
  files: number;
  nodes: number;
  edges: number;
  children: number;
  warnings: string[];
}

/** Parse the JSON object emitted by `index --json`. Returns null on parse failure. */
export function parseJsonStats(stdout: string): IndexJsonStats | null {
  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed as IndexJsonStats;
  } catch {
    return null;
  }
}

/** Whether to load the indexed graph into Neo4j after (re)indexing.
 *  False in explicit jsonl mode, or in auto mode without NEO4J_PASSWORD
 *  (zero-infra). True for neo4j mode or auto-with-DB. */
export function shouldLoadNeo4j(): boolean {
  const mode = (process.env.REPOSKEIN_STORE ?? "auto").toLowerCase();
  if (mode === "jsonl") return false;
  return !!process.env.NEO4J_PASSWORD;
}
