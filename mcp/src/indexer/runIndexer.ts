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

export function parseIndexStats(stdout: string): { nodes: number; edges: number } {
  const m = stdout.match(/(\d+)\s+nodes,\s+(\d+)\s+edges/);
  if (!m) return { nodes: 0, edges: 0 };
  return { nodes: Number(m[1]), edges: Number(m[2]) };
}
