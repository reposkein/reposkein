import { spawn } from "node:child_process";

const ALLOWED_KEYS = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"]);

/** Indexer spawn timeout (~10 minutes). Large repos can be slow but shouldn't hang forever. */
const INDEXER_TIMEOUT_MS = 600_000;
/** Cap accumulated stdout/stderr to the last 1 MB to avoid OOM on runaway output. */
const OUTPUT_CAP_BYTES = 1024 * 1024;

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

/** Repo root the indexer operates on: REPOSKEIN_REPO_PATH or cwd. */
export function repoPath(): string {
  return process.env.REPOSKEIN_REPO_PATH ?? process.cwd();
}

export function spawnIndexer(bin: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: buildChildEnv() });
    let stdout = "";
    let stderr = "";

    /** Append data to a buffer, keeping only the last OUTPUT_CAP_BYTES bytes. */
    function appendCapped(buf: string, chunk: string): string {
      const combined = buf + chunk;
      if (combined.length > OUTPUT_CAP_BYTES) {
        return combined.slice(combined.length - OUTPUT_CAP_BYTES);
      }
      return combined;
    }

    child.stdout.on("data", (d) => { stdout = appendCapped(stdout, d.toString()); });
    child.stderr.on("data", (d) => { stderr = appendCapped(stderr, d.toString()); });
    child.on("error", reject);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`indexer timed out after ${INDEXER_TIMEOUT_MS}ms`));
    }, INDEXER_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
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
