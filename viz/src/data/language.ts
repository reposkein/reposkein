/** Per-cluster dominant-language derivation — pure & deterministic.
 *
 *  A cluster's "language" is the most common programming language among its
 *  descendant File nodes. The language comes from a File's `language` prop when
 *  present, else is inferred from the file extension. Ties break by language
 *  name (ascending) so the result is stable across runs.
 *
 *  This drives the per-language galaxy coloring (nebula-halo tint + the Legend's
 *  Languages section). It reads only the already-built ClientModel, so it works
 *  identically in live and static-export modes.
 *
 *  The language→HUE map lives in scene/encoding.ts (the single visual source of
 *  truth); this module is the DATA layer: normalization + extension inference +
 *  the dominant-language tally. */

import type { ClientModel } from "./clientModel";

/** File-extension → normalized language name. Lower-case keys WITHOUT the dot.
 *  Mirrors the languages the hue map in encoding.ts knows about (+ common
 *  aliases) so inference and coloring agree. */
const EXT_LANGUAGE: Record<string, string> = {
  rs: "rust",
  py: "python",
  pyi: "python",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  go: "go",
  java: "java",
  cs: "csharp",
};

/** Normalize a raw `language` prop value to our canonical lower-case names.
 *  Handles common engine spellings (e.g. "C#", "TypeScript"). Returns "" for
 *  empty/unknown so callers can fall back to extension inference. */
export function normalizeLanguage(raw: string): string {
  const l = raw.trim().toLowerCase();
  if (l === "") return "";
  if (l === "c#" || l === "c-sharp" || l === "cs") return "csharp";
  if (l === "ts") return "typescript";
  if (l === "js") return "javascript";
  if (l === "py") return "python";
  if (l === "golang") return "go";
  return l;
}

/** Infer a normalized language from a file path / name via its extension.
 *  Returns "" when there's no recognized extension. */
export function languageFromPath(pathOrName: string): string {
  const dot = pathOrName.lastIndexOf(".");
  if (dot < 0 || dot === pathOrName.length - 1) return "";
  const ext = pathOrName.slice(dot + 1).toLowerCase();
  return EXT_LANGUAGE[ext] ?? "";
}

/** The language of a single File cluster: its node record's `language` prop
 *  (normalized) if known, else inferred from its name/path. "" when unknown. */
function fileLanguage(model: ClientModel, fileKey: string): string {
  const c = model.byKey.get(fileKey);
  if (!c) return "";
  if (c.nodeId) {
    const rec = model.records.get(c.nodeId);
    if (rec) {
      const fromProp = normalizeLanguage(rec.language);
      if (fromProp) return fromProp;
      const fromPath = languageFromPath(rec.filePath || c.name);
      if (fromPath) return fromPath;
    }
  }
  return languageFromPath(c.name);
}

/** Tally descendant-File languages for a cluster and return the dominant one
 *  (most frequent; tie-break by name asc). Returns "" if no descendant file has
 *  a recognizable language. Deterministic. */
export function dominantLanguage(model: ClientModel, clusterKey: string): string {
  const counts = new Map<string, number>();
  const visit = (key: string): void => {
    const c = model.byKey.get(key);
    if (!c) return;
    if (c.kind === "file") {
      const lang = fileLanguage(model, key);
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
      return; // files have no sub-clusters worth recursing for language
    }
    for (const child of c.children) visit(child);
  };
  // A file cluster passed directly answers for itself.
  const self = model.byKey.get(clusterKey);
  if (self?.kind === "file") return fileLanguage(model, clusterKey);
  visit(clusterKey);

  let best = "";
  let bestN = 0;
  // Sort entries by name asc for a deterministic tie-break.
  for (const [lang, n] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (n > bestN) {
      bestN = n;
      best = lang;
    }
  }
  return best;
}

/** The set of distinct languages present across ALL files in the graph, sorted
 *  ascending. Drives the Legend's Languages section (only present langs shown).
 *  Memoize at the call site (it's O(files)). Deterministic. */
export function presentLanguages(model: ClientModel): string[] {
  const set = new Set<string>();
  for (const c of model.byKey.values()) {
    if (c.kind !== "file") continue;
    const lang = fileLanguage(model, c.key);
    if (lang) set.add(lang);
  }
  return [...set].sort();
}

/** Dominant language for EVERY non-symbol cluster, computed bottom-up so each
 *  cluster's tally reuses its children's file tallies. O(files · depth) but only
 *  run once per model (memoize at the call site). Returns key → language ("" if
 *  unknown). */
export function dominantLanguageByCluster(model: ClientModel): Map<string, string> {
  // Per-cluster language COUNTS, accumulated bottom-up via ancestor chains so we
  // visit each file once and roll its language up to every ancestor.
  const counts = new Map<string, Map<string, number>>();
  const ensure = (key: string): Map<string, number> => {
    let m = counts.get(key);
    if (!m) {
      m = new Map();
      counts.set(key, m);
    }
    return m;
  };
  for (const c of model.byKey.values()) {
    if (c.kind !== "file") continue;
    const lang = fileLanguage(model, c.key);
    if (!lang) continue;
    const chain = model.ancestors.get(c.key);
    if (!chain) continue;
    for (const ak of chain) {
      const m = ensure(ak);
      m.set(lang, (m.get(lang) ?? 0) + 1);
    }
  }
  const out = new Map<string, string>();
  for (const [key, m] of counts) {
    let best = "";
    let bestN = 0;
    for (const [lang, n] of [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (n > bestN) {
        bestN = n;
        best = lang;
      }
    }
    if (best) out.set(key, best);
  }
  return out;
}
