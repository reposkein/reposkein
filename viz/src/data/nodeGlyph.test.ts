import { describe, it, expect } from "vitest";
import { nodeKindGlyph, nodeKindColorVar } from "./nodeGlyph";
import { NODE_KIND_META } from "../scene/encoding";
import { tokenSlug } from "../styles/tokens";

describe("nodeKindGlyph", () => {
  it("has a distinct glyph for every kind in the encoding SSoT", () => {
    for (const { kind } of NODE_KIND_META) {
      expect(nodeKindGlyph(kind)).toBeTruthy();
    }
    // Distinct: no two known kinds silently collapse onto the same glyph.
    const glyphs = NODE_KIND_META.map((m) => nodeKindGlyph(m.kind));
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("falls back to a neutral glyph for an unknown kind", () => {
    expect(nodeKindGlyph("SomethingNew")).toBe("○");
  });

  it("normalizes raw structural NodeRecord.kind labels (File/Directory/Repository)", () => {
    expect(nodeKindGlyph("File")).toBe(nodeKindGlyph("file"));
    expect(nodeKindGlyph("Directory")).toBe(nodeKindGlyph("dir"));
    expect(nodeKindGlyph("Repository")).toBe(nodeKindGlyph("galaxy"));
    // And distinct from a symbol glyph — the normalization must not collapse
    // structural and symbol kinds onto each other.
    expect(nodeKindGlyph("File")).not.toBe(nodeKindGlyph("Function"));
  });
});

describe("nodeKindColorVar", () => {
  it("matches the CSS variable name the token generator actually emits", () => {
    for (const { kind } of NODE_KIND_META) {
      expect(nodeKindColorVar(kind)).toBe(`var(--color-node-${tokenSlug(kind)})`);
    }
  });

  it("normalizes raw structural NodeRecord.kind labels to the token's ClusterKind vocabulary", () => {
    expect(nodeKindColorVar("File")).toBe("var(--color-node-file)");
    expect(nodeKindColorVar("Directory")).toBe("var(--color-node-dir)");
    expect(nodeKindColorVar("Repository")).toBe("var(--color-node-galaxy)");
  });
});
