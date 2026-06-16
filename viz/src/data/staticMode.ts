/** Static (server-less) export mode (design: share & scale §P3).
 *
 *  The `reposkein-mcp view --export` command bakes the repo's graph into a
 *  `graph-data.js` that assigns `window.__REPOSKEIN_GRAPH__` BEFORE the app
 *  bundle loads. When that global is present we skip ALL network fetches and
 *  build the model on the MAIN thread from the inlined JSONL text, so the
 *  viewer works from `file://` and from any static host subpath (GitHub Pages
 *  /repo/, etc.) with no server.
 *
 *  This module is the single source of truth for "are we static?" and provides
 *  a main-thread model build mirroring the worker's pipeline. Pure aside from
 *  the window read. */

import { parseGraph } from "./parse";
import { buildModel } from "./model";
import type { GraphManifest } from "./api";
import type { WorkerResult } from "./worker/graph.worker";

/** Shape injected by graph-data.js. nodesText/edgesText are the raw JSONL. */
export interface StaticGraphPayload {
  manifest: GraphManifest;
  nodesText: string;
  edgesText: string;
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
 *  identical. The federated branch reads inlined text from the manifest's
 *  federated[] entries' nodesUrl/edgesUrl ONLY if they are data: inlined —
 *  the export bakes a single repo (M1), so federation is typically empty. */
export function buildStaticResult(payload: StaticGraphPayload): WorkerResult {
  const graph = parseGraph(payload.nodesText, payload.edgesText);
  const model = buildModel(graph);
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
  };
}
