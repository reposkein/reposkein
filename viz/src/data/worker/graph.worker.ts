/** Graph worker: fetch JSONL → parse → cluster tree → deterministic layout,
 *  all off the main thread (design §2.3, §4.1). Posts the model back to the
 *  UI, transferring the positions Float32Array zero-copy.
 *
 *  M2: supports federated repos (manifest.federated). Each federated repo's
 *  nodes/edges are merged into the combined graph before building the model. */

import { fetchManifest, fetchText } from "../api";
import { parseGraph } from "../parse";
import { buildModel } from "../model";
import type { ClusterNode } from "../cluster";
import type { DrawEdge, NodeRecord } from "../model";

export interface WorkerResult {
  type: "result";
  repoId: string;
  rootKey: string;
  /** Serialized cluster tree (Maps don't structured-clone as cleanly to keep
   *  the contract explicit, so we send arrays). */
  clusters: ClusterNode[];
  keys: string[];
  positions: Float32Array;
  drawEdges: DrawEdge[];
  records: [string, NodeRecord][];
  fingerprint: string;
  counts: { nodes: number; edges: number };
}

export interface WorkerError {
  type: "error";
  message: string;
}

export interface WorkerProgress {
  type: "progress";
  phase: string;
}

async function run(): Promise<void> {
  const post = (m: WorkerProgress) => self.postMessage(m);
  post({ type: "progress", phase: "fetching manifest" });
  const manifest = await fetchManifest();

  post({ type: "progress", phase: "fetching graph" });
  const [nodesText, edgesText] = await Promise.all([
    fetchText(manifest.root.nodesUrl),
    fetchText(manifest.root.edgesUrl),
  ]);

  post({ type: "progress", phase: "parsing" });
  const graph = parseGraph(nodesText, edgesText);

  // M2: merge federated repos into the combined graph.
  if (manifest.federated && manifest.federated.length > 0) {
    post({ type: "progress", phase: "fetching federated repos" });
    for (const fed of manifest.federated) {
      const [fedNodes, fedEdges] = await Promise.all([
        fetchText(fed.nodesUrl),
        fetchText(fed.edgesUrl),
      ]);
      const fedGraph = parseGraph(fedNodes, fedEdges);
      // Merge nodes and edges into the primary graph.
      graph.nodes.push(...fedGraph.nodes);
      graph.edges.push(...fedGraph.edges);
    }
  }

  post({ type: "progress", phase: "charting the sky" });
  const model = buildModel(graph);

  const result: WorkerResult = {
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
  };

  // Transfer the positions buffer (zero-copy).
  self.postMessage(result, [result.positions.buffer]);
}

self.onmessage = (e: MessageEvent) => {
  if ((e.data as { cmd?: string })?.cmd === "load") {
    run().catch((err) => {
      const msg: WorkerError = {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      self.postMessage(msg);
    });
  }
};
