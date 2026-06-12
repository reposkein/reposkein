import type { ToolResult } from "./readCypher.js";
import { spawnIndexer, parseIndexStats, indexerBinPath, repoPath } from "../indexer/runIndexer.js";

export type RunResult =
  | { ok: true; nodes: number; edges: number }
  | { ok: false; error: string };

export interface IndexerDeps {
  run: (repoId: string) => Promise<RunResult>;
}

/** Default runner: index the repo, then load it into Neo4j. */
function defaultRun(repoId: string): Promise<RunResult> {
  const bin = indexerBinPath();
  const path = repoPath();
  return (async (): Promise<RunResult> => {
    const idx = await spawnIndexer(bin, ["index", "--repo-id", repoId, path]);
    if (idx.code !== 0) return { ok: false, error: `index failed: ${idx.stderr || idx.stdout}` };
    const load = await spawnIndexer(bin, ["load", "--repo-id", repoId, path]);
    if (load.code !== 0) return { ok: false, error: `load failed: ${load.stderr || load.stdout}` };
    return { ok: true, ...parseIndexStats(idx.stdout) };
  })();
}

function makeRunner(repoId: string, deps?: Partial<IndexerDeps>) {
  const run = deps?.run ?? (() => defaultRun(repoId));
  return run;
}

export interface InitArgs {
  path?: string;
  full?: boolean;
}

export function makeInitCpgSkeleton(repoId: string, deps?: Partial<IndexerDeps>) {
  const run = makeRunner(repoId, deps);
  return async (_args: InitArgs): Promise<ToolResult> => {
    const start = Date.now();
    const r = await run(repoId);
    if (!r.ok) {
      return { content: [{ type: "text", text: r.error }], isError: true };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, nodes: r.nodes, edges: r.edges, duration_ms: Date.now() - start, warnings: [] }),
      }],
    };
  };
}

export interface ReindexArgs {
  path: string;
}

export function makeReindexFile(repoId: string, deps?: Partial<IndexerDeps>) {
  const run = makeRunner(repoId, deps);
  return async (args: ReindexArgs): Promise<ToolResult> => {
    if (!args || !args.path) {
      return { content: [{ type: "text", text: "reindex_file requires a 'path'" }], isError: true };
    }
    // v1: full reindex (single-file incremental reindex is deferred).
    const start = Date.now();
    const r = await run(repoId);
    if (!r.ok) {
      return { content: [{ type: "text", text: r.error }], isError: true };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ok: true, reindexed: args.path, nodes: r.nodes, edges: r.edges, duration_ms: Date.now() - start, full_reindex: true }),
      }],
    };
  };
}
