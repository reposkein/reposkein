import { spawn } from "node:child_process";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Path to the indexer binary: REPOSKEIN_INDEXER_BIN or `reposkein-indexer`. */
export function indexerBinPath(): string {
  return process.env.REPOSKEIN_INDEXER_BIN ?? "reposkein-indexer";
}

/** Repo root the indexer operates on: REPOSKEIN_REPO_PATH or cwd. */
export function repoPath(): string {
  return process.env.REPOSKEIN_REPO_PATH ?? process.cwd();
}

export function spawnIndexer(bin: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** @deprecated Use the --json flag and parseJsonStats instead. Kept for legacy callers. */
export function parseIndexStats(stdout: string): { nodes: number; edges: number } {
  const m = stdout.match(/(\d+)\s+nodes,\s+(\d+)\s+edges/);
  if (!m) return { nodes: 0, edges: 0 };
  return { nodes: Number(m[1]), edges: Number(m[2]) };
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
