import type { ToolResult } from "./readCypher.js";
import { spawnIndexer, parseJsonStats, indexerBinPath, repoPath } from "../indexer/runIndexer.js";

export type RunResult =
  | { ok: true; nodes: number; edges: number; files: number; warnings: string[] }
  | { ok: false; error: string };

export interface IndexerDeps {
  run: (repoId: string, path: string) => Promise<RunResult>;
}

/** Default runner: index the repo with --json, then load it into Neo4j. */
function defaultRun(repoId: string, indexPath: string): Promise<RunResult> {
  const bin = indexerBinPath();
  return (async (): Promise<RunResult> => {
    const idx = await spawnIndexer(bin, ["index", "--json", "--repo-id", repoId, indexPath]);
    if (idx.code !== 0) return { ok: false, error: `index failed: ${idx.stderr || idx.stdout}` };
    const stats = parseJsonStats(idx.stdout);
    if (!stats) return { ok: false, error: `index --json returned unparseable output: ${idx.stdout}` };
    const load = await spawnIndexer(bin, ["load", "--repo-id", repoId, indexPath]);
    if (load.code !== 0) return { ok: false, error: `load failed: ${load.stderr || load.stdout}` };
    return {
      ok: true,
      nodes: stats.nodes,
      edges: stats.edges,
      files: stats.files,
      warnings: stats.warnings ?? [],
    };
  })();
}

function makeRunner(repoId: string, deps?: Partial<IndexerDeps>) {
  const run = deps?.run ?? ((id: string, path: string) => defaultRun(id, path));
  return run;
}

export interface InitArgs {
  path?: string;
  full?: boolean;
}

export function makeInitCpgSkeleton(repoId: string, deps?: Partial<IndexerDeps>) {
  const run = makeRunner(repoId, deps);
  return async (args: InitArgs): Promise<ToolResult> => {
    const indexPath = args?.path ?? repoPath();
    const start = Date.now();
    const r = await run(repoId, indexPath);
    if (!r.ok) {
      return { content: [{ type: "text", text: r.error }], isError: true };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          nodes: r.nodes,
          edges: r.edges,
          files: r.files,
          duration_ms: Date.now() - start,
          warnings: r.warnings,
        }),
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
    const indexPath = repoPath();
    const start = Date.now();
    const r = await run(repoId, indexPath);
    if (!r.ok) {
      return { content: [{ type: "text", text: r.error }], isError: true };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          reindexed: args.path,
          nodes: r.nodes,
          edges: r.edges,
          files: r.files,
          duration_ms: Date.now() - start,
          full_reindex: true,
          warnings: r.warnings,
        }),
      }],
    };
  };
}
