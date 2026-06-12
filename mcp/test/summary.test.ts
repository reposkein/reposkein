import { describe, it, expect } from "vitest";
import { summaryState } from "../src/profile/summary.js";

describe("summaryState", () => {
  it("needs enrichment when there is no summary", () => {
    expect(summaryState({ semantic_summary: null, summary_of_hash: null, content_hash: "h" }))
      .toEqual({ summary: null, stale: false, needsEnrichment: true });
  });

  it("is fresh when summary_of_hash matches content_hash", () => {
    expect(summaryState({ semantic_summary: "does X", summary_of_hash: "h", content_hash: "h" }))
      .toEqual({ summary: "does X", stale: false, needsEnrichment: false });
  });

  it("is stale (and needs enrichment) when hashes diverge", () => {
    expect(summaryState({ semantic_summary: "old", summary_of_hash: "h1", content_hash: "h2" }))
      .toEqual({ summary: "old", stale: true, needsEnrichment: true });
  });
});
