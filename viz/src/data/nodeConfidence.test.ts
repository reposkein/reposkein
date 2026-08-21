import { describe, it, expect } from "vitest";
import { buildMinConfidenceIndex, nodeConfidence } from "./nodeConfidence";
import type { ClientModel } from "./clientModel";
import type { DrawEdge } from "./model";

function edge(from: string, to: string, confidence: number): DrawEdge {
  return { from, to, type: "CALLS", resolution: "exact", confidence, crossRepo: false };
}

function modelWith(drawEdges: DrawEdge[]): ClientModel {
  return { drawEdges } as unknown as ClientModel;
}

describe("buildMinConfidenceIndex / nodeConfidence", () => {
  it("defaults an untouched node to full confidence (1, no badge)", () => {
    const index = buildMinConfidenceIndex(modelWith([]));
    expect(nodeConfidence(index, "missing")).toBe(1);
  });

  it("indexes the minimum confidence across a node's incident edges, both directions", () => {
    const index = buildMinConfidenceIndex(
      modelWith([edge("a", "b", 0.9), edge("c", "a", 0.4), edge("b", "c", 1.0)]),
    );
    expect(nodeConfidence(index, "a")).toBeCloseTo(0.4);
    expect(nodeConfidence(index, "b")).toBeCloseTo(0.9);
    expect(nodeConfidence(index, "c")).toBeCloseTo(0.4);
  });

  it("a node touched only by exact (confidence 1) edges gets no badge", () => {
    const index = buildMinConfidenceIndex(modelWith([edge("a", "b", 1.0)]));
    expect(nodeConfidence(index, "a")).toBe(1);
    expect(nodeConfidence(index, "b")).toBe(1);
  });
});
