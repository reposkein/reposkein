/** Static (server-less) export mode (design: share & scale §P3).
 *
 *  The `reposkein-mcp view --export` command bakes the repo's graph into a
 *  `graph-data.js` that assigns `window.__REPOSKEIN_GRAPH__` BEFORE the app
 *  bundle loads. When that global is present we skip ALL network fetches and
 *  build the model on the MAIN thread from the inlined JSONL text, so the
 *  viewer needs no backend of any kind and runs from any static host subpath
 *  (GitHub Pages /repo/, etc.). It still needs an http(s) origin — the entry is
 *  a module script, which browsers block on `file://`.
 *
 *  This module is the single source of truth for "are we static?" and provides
 *  a main-thread model build mirroring the worker's pipeline. Pure aside from
 *  the window read. */

import { parseGraph } from "./parse";
import { buildModel } from "./model";
import { layoutFingerprint } from "./layout";
import { loadCachedPositions, storeCachedPositions } from "./positionCache";
import type { GraphManifest, RepoMeta, SourceSlice } from "./api";
import type { WorkerResult } from "./worker/graph.worker";
import type { CochangeMap } from "./temporal";

/** One federated repo's data, inlined in full for a self-contained export
 *  (no fetch of the manifest's federated[] nodesUrl/edgesUrl at runtime). */
export interface StaticFederatedEntry {
  repoId: string;
  nodesText: string;
  edgesText: string;
}

/** Shape injected by graph-data.js. nodesText/edgesText are the raw JSONL. */
export interface StaticGraphPayload {
  manifest: GraphManifest;
  nodesText: string;
  edgesText: string;
  federatedText?: StaticFederatedEntry[];
  meta?: RepoMeta;
  cochange?: CochangeMap;
  /** node id -> baked source slice (--with-source, size-capped). */
  sourceSlices?: Record<string, SourceSlice>;
}

declare global {
  interface Window {
    __REPOSKEIN_GRAPH__?: StaticGraphPayload;
  }
}

/** The baked payload if running as a static export, else null. */
export function staticPayload(): StaticGraphPayload | null {
  if (typeof window === "undefined") return null;
  return window.__REPOSKEIN_GRAPH__ ?? null;
}

/** True when the viewer is running from a baked static export (no live server).
 *  Server-only features (source peek, temporal, vscode:// links) degrade. */
export function isStaticMode(): boolean {
  return staticPayload() !== null;
}

/** Build the worker-result-shaped model on the main thread from the baked
 *  payload (federation included, mirroring graph.worker.ts). The result is
 *  handed to the SAME fromWorker() the worker path uses, so downstream code is
 *  identical. Federated repos are merged from `payload.federatedText` (inlined
 *  text baked by `runExport` — no network fetch, so the export stays
 *  self-contained even under file://). */
export async function buildStaticResult(payload: StaticGraphPayload): Promise<WorkerResult> {
  const graph = parseGraph(payload.nodesText, payload.edgesText);

  for (const fed of payload.federatedText ?? []) {
    const fedGraph = parseGraph(fed.nodesText, fed.edgesText);
    graph.nodes.push(...fedGraph.nodes);
    graph.edges.push(...fedGraph.edges);
  }

  // Position cache (IndexedDB, main-thread here): reuse a byte-stable layout for
  // this node set + layout version if present, else compute and store. Purely a
  // speed win; best-effort, never throws (falls back to computing on any error).
  const fp = layoutFingerprint(graph.nodes.map((n) => n.id));
  const cached = await loadCachedPositions(fp);
  const model = buildModel(graph, { cachedPositions: cached ?? undefined });
  if (!cached) void storeCachedPositions(fp, model.layout.positions.slice());

  return {
    type: "result",
    repoId: model.tree.repoId,
    rootKey: model.tree.rootKey,
    clusters: [...model.tree.byKey.values()],
    keys: model.layout.keys,
    positions: model.layout.positions,
    drawEdges: model.drawEdges,
    records: [...model.records.entries()],
    fingerprint: model.fingerprint,
    counts: { nodes: graph.nodes.length, edges: graph.edges.length },
    repoRoot: payload.manifest.root.repoRoot ?? null,
    repoMeta: payload.meta ?? null,
  };
}

/** Baked co-change map for a static export (from `runExport`'s temporal bake),
 *  or {} when not running statically / none was baked. Mirrors fetchTemporal's
 *  server call so the coupling overlay works offline. */
export function staticCochange(): CochangeMap {
  return staticPayload()?.cochange ?? {};
}

/** Looks up a baked source slice (--with-source) for an exact [path,start,end]
 *  match, or null when static mode has no baked slice for that range (the
 *  Inspector then shows no source, same as any other static degrade). */
export function staticSourceSlice(path: string, start: number, end: number): SourceSlice | null {
  const slices = staticPayload()?.sourceSlices;
  if (!slices) return null;
  for (const entry of Object.values(slices)) {
    if (entry.path === path && entry.start === start && entry.end === end) return entry;
  }
  return null;
}
