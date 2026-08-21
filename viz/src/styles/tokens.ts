/** The token BRIDGE: turns `scene/encoding.ts` — the single source of truth for
 *  visual encoding — into a Tailwind v4 `@theme` block so CSS/Tailwind chrome
 *  and the WebGL scene can never drift apart.
 *
 *  encoding.ts stays the SSoT: nothing here invents a color. This module only
 *  RENAMES its exports into CSS custom properties. The output is written to
 *  `src/styles/tokens.generated.css` by the `reposkein-tokens` Vite plugin at
 *  both dev and build time; the file is git-ignored precisely so it can never
 *  be hand-edited into a second source of truth.
 *
 *  Determinism is a contract (tokens.test.ts asserts it): the same encoding.ts
 *  must render byte-identical CSS on every machine and every run, so the plugin
 *  can skip a no-op write and a stale checkout can't produce a phantom diff. */

import {
  BRAND,
  EDGE_TYPE_META,
  LANGUAGE_DEFAULT_HEX,
  LANGUAGE_HEX,
  NODE_KIND_META,
} from "../scene/encoding";

/** CSS-identifier-safe slug for a token name segment: lower-case, non
 *  alphanumerics collapsed to a single `-`. `Function` → `function`,
 *  `csharp` → `csharp`, `IMPORTS` → `imports`. */
export function tokenSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface Token {
  name: string;
  value: string;
}

/** Every token, grouped, in the order the CSS emits them. Exported so the test
 *  can assert coverage of each encoding table without re-parsing CSS. */
export function tokenGroups(): { title: string; tokens: Token[] }[] {
  const brand: Token[] = Object.entries(BRAND)
    .map(([k, v]) => ({ name: `--color-brand-${tokenSlug(k)}`, value: v }))
    .sort(byName);

  const nodeKinds: Token[] = NODE_KIND_META.map((m) => ({
    name: `--color-node-${tokenSlug(m.kind)}`,
    value: m.color,
  })).sort(byName);

  const edgeTypes: Token[] = EDGE_TYPE_META.map((m) => ({
    name: `--color-edge-${tokenSlug(m.type)}`,
    value: m.color,
  })).sort(byName);

  const languages: Token[] = [
    ...Object.entries(LANGUAGE_HEX).map(([lang, hexValue]) => ({
      name: `--color-lang-${tokenSlug(lang)}`,
      value: hexValue,
    })),
    { name: "--color-lang-default", value: LANGUAGE_DEFAULT_HEX },
  ].sort(byName);

  return [
    { title: "brand accents (BRAND)", tokens: brand },
    { title: "node kinds (NODE_KIND_META)", tokens: nodeKinds },
    { title: "edge types (EDGE_TYPE_META)", tokens: edgeTypes },
    { title: "languages (LANGUAGE_HEX + LANGUAGE_DEFAULT_HEX)", tokens: languages },
  ];
}

/** Sorted by token name so map iteration order can never leak into the bytes. */
function byName(a: Token, b: Token): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The generated CSS. Pure + deterministic: no timestamps, no absolute paths,
 *  no environment reads — the file is a function of encoding.ts alone. */
export function renderTokensCss(): string {
  const lines: string[] = [
    "/* GENERATED — DO NOT EDIT. Source: src/scene/encoding.ts via",
    " * src/styles/tokens.ts, emitted by the `reposkein-tokens` Vite plugin.",
    " * Git-ignored on purpose: edit encoding.ts, never this file. */",
    // `static` because Tailwind v4 otherwise tree-shakes theme variables no
    // utility references — and the point of the bridge is that these vars exist
    // for hand-written CSS and future components, not just for `bg-*` classes.
    "@theme static {",
  ];
  const groups = tokenGroups();
  groups.forEach((group, i) => {
    if (i > 0) lines.push("");
    lines.push(`  /* ${group.title} */`);
    for (const t of group.tokens) lines.push(`  ${t.name}: ${t.value};`);
  });
  lines.push("}", "");
  return lines.join("\n");
}
