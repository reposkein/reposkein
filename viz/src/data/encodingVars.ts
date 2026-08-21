/** encoding.ts → CSS custom-property NAMES. The one place chrome asks "which
 *  var holds this hue?".
 *
 *  `styles/tokens.ts` turns `scene/encoding.ts` into an `@theme` block
 *  (`--color-node-function: #ffe08a;` …). Chrome that needs a *dynamic* hue —
 *  a legend swatch, a filter chip, a palette row's dot — can't name a Tailwind
 *  class for it (v4 extracts classes statically, so `bg-[var(--color-node-${k})]`
 *  never emits), so it references the VAR instead. Routing every such
 *  reference through this module is what makes the color-identity chain
 *  auditable in one assertion: chip var === legend var === generated token ===
 *  encoding.ts hex (see `panels/colorIdentity.test.tsx`).
 *
 *  The slug MUST match `styles/tokens.ts`'s `tokenSlug` (it is the same three
 *  lines, kept local because `styles/` is a leaf Vite-plugin-only module and
 *  inverting that dependency direction costs more than this duplication).
 *  `colorIdentity.test.tsx` asserts the two agree for every table entry, so a
 *  drift is a red test, not a silently-broken swatch. */

/** Raw structural graph label → the shorter `ClusterKind` vocabulary that
 *  `NODE_KIND_META` (and therefore the generated tokens) key on. Symbol labels
 *  (`"Function"`, `"Class"`, …) already match verbatim and pass through. */
const STRUCTURAL_KIND: Record<string, string> = {
  Repository: "galaxy",
  Directory: "dir",
  File: "file",
};

/** Normalizes a `NodeRecord.kind` to the key `NODE_KIND_META` uses. */
export function normalizeNodeKind(kind: string): string {
  return STRUCTURAL_KIND[kind] ?? kind;
}

/** CSS-identifier-safe slug — mirrors `styles/tokens.ts`'s `tokenSlug`. */
export function varSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `"Function"` → `"--color-node-function"`. */
export function nodeKindVarName(kind: string): string {
  return `--color-node-${varSlug(normalizeNodeKind(kind))}`;
}

/** `"IMPORTS"` → `"--color-edge-imports"`. */
export function edgeTypeVarName(type: string): string {
  return `--color-edge-${varSlug(type)}`;
}

/** `"typescript"` → `"--color-lang-typescript"`. Unknown languages have no
 *  token of their own — they fall back to `--color-lang-default`, exactly as
 *  `encoding.languageHex` falls back to `LANGUAGE_DEFAULT_HEX`. */
export function languageVarName(language: string, known: boolean): string {
  return known ? `--color-lang-${varSlug(language)}` : "--color-lang-default";
}

/** Wraps a var name for use as a CSS value: `var(--color-node-function)`. */
export function cssVar(name: string): string {
  return `var(${name})`;
}

/** `nodeKindColorVar("Function")` → `"var(--color-node-function)"`. */
export function nodeKindColorVar(kind: string): string {
  return cssVar(nodeKindVarName(kind));
}

/** `edgeTypeColorVar("IMPORTS")` → `"var(--color-edge-imports)"`. */
export function edgeTypeColorVar(type: string): string {
  return cssVar(edgeTypeVarName(type));
}

/** `languageColorVar("go", true)` → `"var(--color-lang-go)"`. */
export function languageColorVar(language: string, known: boolean): string {
  return cssVar(languageVarName(language, known));
}
