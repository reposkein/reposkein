import type { ToolResult } from "./readCypher.js";
import {
  spawnIndexer,
  parseJsonStats,
  repoPath,
  shouldLoadNeo4j,
} from "../indexer/runIndexer.js";
import { ensureIndexerBinary } from "../indexer/fetchBinary.js";
import {
  decisionsAffectedBy,
  mergeDeltas,
  readPendingDelta,
  type DecisionAffected,
  type GraphDeltaJson,
} from "../indexer/decisionsAffected.js";

export type RunResult =
  | {
      ok: true;
      nodes: number;
      edges: number;
      files: number;
      warnings: string[];
      graph_delta?: GraphDeltaJson;
    }
  | { ok: false; error: string };

export interface RunOpts {
  verb?: "index" | "reindex";
  file?: string;
}

export interface IndexerDeps {
  run: (repoId: string, path: string, opts?: RunOpts) => Promise<RunResult>;
}

/** Default runner: run the index/reindex verb with --json, then load into Neo4j
 *  unless we're in JSONL mode (shouldLoadNeo4j() === false). */
function defaultRun(repoId: string, indexPath: string, opts?: RunOpts): Promise<RunResult> {
  const verb = opts?.verb ?? "index";
  return (async (): Promise<RunResult> => {
    const bin = await ensureIndexerBinary();
    const verbArgs =
      verb === "reindex"
        ? ["reindex", "--json", "--repo-id", repoId, indexPath, ...(opts?.file ? ["--file", opts.file] : [])]
        : ["index", "--json", "--repo-id", repoId, indexPath];
    const idx = await spawnIndexer(bin, verbArgs);
    if (idx.code !== 0) return { ok: false, error: `${verb} failed: ${idx.stderr || idx.stdout}` };
    const stats = parseJsonStats(idx.stdout);
    if (!stats) return { ok: false, error: `${verb} --json returned unparseable output: ${idx.stdout}` };
    if (shouldLoadNeo4j()) {
      const load = await spawnIndexer(bin, ["load", "--repo-id", repoId, indexPath]);
      if (load.code !== 0) return { ok: false, error: `load failed: ${load.stderr || load.stdout}` };
    }
    return {
      ok: true,
      nodes: stats.nodes,
      edges: stats.edges,
      files: stats.files,
      warnings: stats.warnings ?? [],
      ...(stats.graph_delta ? { graph_delta: stats.graph_delta } : {}),
    };
  })();
}

/** Combines this run's delta with the pending one hook-driven indexes parked
 *  (their stdout is discarded — post-merge drift would otherwise vanish), and
 *  cross-references the decision log. `root` MUST be the repo that was
 *  actually indexed: consulting the env repo's decisions (or consuming its
 *  pending delta) while indexing some other path would cross the streams.
 *  Returns {} when there is no drift. */
function driftFields(
  root: string,
  repoId: string,
  runDelta: GraphDeltaJson | undefined
): {
  graph_delta?: GraphDeltaJson;
  decisions_affected?: DecisionAffected[];
  decisions_check_incomplete?: boolean;
} {
  const pending = readPendingDelta(root);
  let delta = runDelta ?? null;
  if (pending) delta = delta ? mergeDeltas(delta, pending) : pending;
  if (!delta) return {};
  const affected = decisionsAffectedBy(root, delta, repoId);
  return {
    graph_delta: delta,
    ...(affected.length > 0 ? { decisions_affected: affected } : {}),
    // A truncated delta dropped ids past the cap, so an empty/short
    // decisions_affected is NOT proof of no drift — say so instead of
    // reading as "checked everything".
    ...(delta.truncated ? { decisions_check_incomplete: true } : {}),
  };
}

function makeRunner(repoId: string, deps?: Partial<IndexerDeps>) {
  const run = deps?.run ?? ((id: string, path: string, opts?: RunOpts) => defaultRun(id, path, opts));
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
          ...driftFields(indexPath, repoId, r.graph_delta),
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
    const indexPath = repoPath();
    const start = Date.now();
    const r = await run(repoId, indexPath, { verb: "reindex", file: args.path });
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
          loaded: shouldLoadNeo4j(),
          warnings: r.warnings,
          ...driftFields(indexPath, repoId, r.graph_delta),
        }),
      }],
    };
  };
}
