/** Per-node confidence index for the command palette's confidence badge.
 *
 *  `NodeRecord` has no confidence field of its own — confidence lives on
 *  `DrawEdge` (the resolver's per-edge confidence score). A node "is
 *  low-confidence" when at least one of its incident relationship edges was a
 *  guess: this indexes the MINIMUM confidence across a node's incident edges
 *  (both directions), so the palette can badge a node touched by even one
 *  ambiguous/name-match edge. A node with only exact edges — or no
 *  relationship edges at all — reports full confidence (1) and gets no badge.
 *
 *  Built ONCE per model (like `ClientModel.neighborsByNode`), not re-scanned
 *  per keystroke: the palette computes this via `useMemo` keyed on the model. */

import type { ClientModel } from "./clientModel";

export function buildMinConfidenceIndex(model: ClientModel): Map<string, number> {
  const index = new Map<string, number>();
  const consider = (id: string, confidence: number) => {
    const prev = index.get(id);
    if (prev === undefined || confidence < prev) index.set(id, confidence);
  };
  for (const e of model.drawEdges) {
    consider(e.from, e.confidence);
    consider(e.to, e.confidence);
  }
  return index;
}

/** Looks up a node's confidence, defaulting to 1 (fully confident / no badge)
 *  when the node has no indexed relationship edges. */
export function nodeConfidence(index: Map<string, number>, id: string): number {
  return index.get(id) ?? 1;
}
