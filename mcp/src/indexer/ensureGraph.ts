import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnIndexer, parseJsonStats } from "./runIndexer.js";
import { ensureIndexerBinary } from "./fetchBinary.js";

export type EnsureOutcome = "present" | "built" | "failed" | "skipped";

export type BuildResult =
  | { ok: true; nodes: number; edges: number }
  | { ok: false; error: string };

export interface EnsureDeps {
  exists: (path: string) => boolean;
  build: (repoId: string, repoPath: string) => Promise<BuildResult>;
  /** Where progress goes. MUST NOT be stdout: that is the MCP stdio transport. */
  log: (message: string) => void;
  now: () => number;
}

export interface EnsureOpts {
  /** REPOSKEIN_STORE, lowercased. */
  mode: string;
  /** Whether a Neo4j password is present in the environment. */
  neo4jConfigured: boolean;
}

async function defaultBuild(repoId: string, path: string): Promise<BuildResult> {
  try {
    const bin = await ensureIndexerBinary();
    const r = await spawnIndexer(bin, ["index", "--json", "--repo-id", repoId, path]);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `exit ${r.code}` };
    const stats = parseJsonStats(r.stdout);
    if (!stats) return { ok: false, error: `index --json returned unparseable output: ${r.stdout}` };
    return { ok: true, nodes: stats.nodes, edges: stats.edges };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Builds the JSONL graph if it is missing, so a fresh clone works on the first query.
 *
 *  `.reposkein/nodes.jsonl` and `edges.jsonl` are derived from the working tree and
 *  git-ignored, so a clone never carries them. Without this the server would fall
 *  through to `UnconfiguredStore` and every tool would fail on a repo that is
 *  perfectly indexable. A full index is seconds even on a large repo, so building it
 *  here is cheaper than making the user discover a setup step.
 *
 *  Skipped when Neo4j is the store: the DB already holds the graph, and building
 *  JSONL would silently switch the backend out from under a configured user.
 *
 *  Never throws and never fails startup: a repo that cannot be indexed should still
 *  bring the server up, with the error explained on stderr. */
export async function ensureGraph(
  repoPath: string | undefined,
  repoId: string | undefined,
  opts: EnsureOpts,
  deps?: Partial<EnsureDeps>
): Promise<EnsureOutcome> {
  const exists = deps?.exists ?? existsSync;
  const build = deps?.build ?? defaultBuild;
  const log = deps?.log ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const now = deps?.now ?? Date.now;

  if (!repoPath || !repoId) return "skipped";
  if (opts.mode === "neo4j") return "skipped";
  if (opts.mode === "auto" && opts.neo4jConfigured) return "skipped";
  if (exists(join(repoPath, ".reposkein", "nodes.jsonl"))) return "present";

  log(
    `reposkein: no graph in ${join(repoPath, ".reposkein")}; building it now. ` +
      "nodes.jsonl and edges.jsonl are derived from your working tree and git-ignored, " +
      "so a fresh clone builds them once. This usually takes a few seconds."
  );
  const started = now();
  const r = await build(repoId, repoPath);
  const secs = ((now() - started) / 1000).toFixed(1);
  if (!r.ok) {
    log(
      `reposkein: graph build failed after ${secs}s: ${r.error}. ` +
        `Tools will report no graph until this succeeds. Run \`reposkein-mcp index ${repoPath}\` to see the full output.`
    );
    return "failed";
  }
  log(`reposkein: graph built in ${secs}s (${r.nodes} nodes, ${r.edges} edges).`);
  return "built";
}
