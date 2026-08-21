import { describe, it, expect } from "vitest";
import { renderTokensCss, tokenGroups, tokenSlug } from "./tokens";
import {
  BRAND,
  EDGE_TYPE_META,
  LANGUAGE_DEFAULT_HEX,
  LANGUAGE_HEX,
  NODE_KIND_META,
} from "../scene/encoding";

/** The generated `@theme` block is a build artifact (git-ignored, regenerated at
 *  dev + build), so its ONLY guarantees are: it is a pure function of
 *  encoding.ts, and it is byte-stable. Both are asserted here — a
 *  non-deterministic generator would produce phantom rebuilds and make the
 *  "encoding.ts is the SSoT" claim unverifiable. */
describe("renderTokensCss", () => {
  it("is deterministic: repeated renders are byte-identical", () => {
    const a = renderTokensCss();
    const b = renderTokensCss();
    const c = renderTokensCss();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("emits a static @theme block (Tailwind must not tree-shake the tokens)", () => {
    const css = renderTokensCss();
    expect(css).toContain("@theme static {");
    expect(css.trimEnd().endsWith("}")).toBe(true);
    // Balanced braces: exactly one block.
    expect(css.split("{").length - 1).toBe(1);
    expect(css.split("}").length - 1).toBe(1);
  });

  it("covers every encoding table, with encoding.ts as the only value source", () => {
    const css = renderTokensCss();
    for (const [name, value] of Object.entries(BRAND)) {
      expect(css).toContain(`--color-brand-${tokenSlug(name)}: ${value};`);
    }
    for (const meta of NODE_KIND_META) {
      expect(css).toContain(`--color-node-${tokenSlug(meta.kind)}: ${meta.color};`);
    }
    for (const meta of EDGE_TYPE_META) {
      expect(css).toContain(`--color-edge-${tokenSlug(meta.type)}: ${meta.color};`);
    }
    for (const [lang, hexValue] of Object.entries(LANGUAGE_HEX)) {
      expect(css).toContain(`--color-lang-${tokenSlug(lang)}: ${hexValue};`);
    }
    expect(css).toContain(`--color-lang-default: ${LANGUAGE_DEFAULT_HEX};`);
  });

  it("declares each token exactly once, with CSS-safe names, sorted per group", () => {
    const groups = tokenGroups();
    const seen = new Set<string>();
    for (const group of groups) {
      const names = group.tokens.map((t) => t.name);
      expect(names).toEqual([...names].sort());
      for (const t of group.tokens) {
        expect(t.name).toMatch(/^--color-[a-z0-9-]+$/);
        expect(t.value).toMatch(/^#[0-9a-fA-F]{6}$/);
        expect(seen.has(t.name)).toBe(false);
        seen.add(t.name);
      }
    }
    // Token count matches the encoding tables exactly (no extras, none missed).
    expect(seen.size).toBe(
      Object.keys(BRAND).length +
        NODE_KIND_META.length +
        EDGE_TYPE_META.length +
        Object.keys(LANGUAGE_HEX).length +
        1,
    );
  });

  it("slugs names into CSS identifiers", () => {
    expect(tokenSlug("Function")).toBe("function");
    expect(tokenSlug("INSTANTIATES")).toBe("instantiates");
    expect(tokenSlug("C#")).toBe("c");
    expect(tokenSlug("some name_here")).toBe("some-name-here");
  });
});
