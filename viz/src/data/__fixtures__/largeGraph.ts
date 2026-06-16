/** Deterministic synthetic large-graph generator (design: share & scale §P4).
 *
 *  Builds a realistic-shaped repo: a directory tree → files → symbols, with
 *  CONTAINS/DEFINES structural edges and typed relationship edges (CALLS /
 *  IMPORTS / INSTANTIATES / ...). SEEDED via mulberry32 — NO Math.random — so
 *  the same parameters always produce the same graph, keeping the scale perf
 *  test reproducible.
 *
 *  Used only by tests; never shipped in the app bundle. */

import { mulberry32 } from "../hash";
import { RELATIONSHIP_EDGE_TYPES, type RawGraph, type RawNode, type RawEdge } from "../types";

const REL_TYPES = [...RELATIONSHIP_EDGE_TYPES];

export interface LargeGraphParams {
  /** Approximate total symbol nodes to generate. */
  symbols: number;
  /** Approximate relationship (drawn) edges to generate. */
  relEdges: number;
  /** Directories per level / files per dir / symbols per file shape knobs. */
  dirs?: number;
  filesPerDir?: number;
  /** PRNG seed (default fixed for reproducibility). */
  seed?: number;
}

/** Generate a deterministic synthetic graph of roughly the requested size.
 *  The repo id is fixed so cluster keys are stable across runs. */
export function makeLargeGraph(params: LargeGraphParams): RawGraph {
  const repo = "big";
  const filesPerDir = params.filesPerDir ?? 8;
  // Default directory count is sized to comfortably HOLD the requested symbols
  // (avg ~5.5 symbols/file), so the generator never runs out of capacity before
  // hitting the target. Caller can still override.
  const dirs = params.dirs ?? Math.max(60, Math.ceil(params.symbols / (filesPerDir * 5)));
  const rng = mulberry32((params.seed ?? 0xbADC0DE) >>> 0);

  const nodes: RawNode[] = [];
  const edges: RawEdge[] = [];

  // Repository + root dir.
  nodes.push({ id: `rs1:${repo}:repo:.`, labels: ["Repository"], props: { name: repo } });
  nodes.push({ id: `rs1:${repo}:dir:.`, labels: ["Directory"], props: { name: ".", path: "." } });

  // Directory tree: a flat-ish two-level tree (top dirs + sub dirs) so the
  // cluster tree has real depth without exploding the count.
  const dirPaths: string[] = [];
  const topDirs = Math.max(1, Math.floor(Math.sqrt(dirs)));
  for (let t = 0; t < topDirs; t++) {
    const top = `pkg${t}`;
    dirPaths.push(top);
    nodes.push({ id: `rs1:${repo}:dir:${top}`, labels: ["Directory"], props: { name: top, path: top } });
    const subs = Math.max(1, Math.floor(dirs / topDirs));
    for (let s = 0; s < subs; s++) {
      const sub = `${top}/mod${s}`;
      dirPaths.push(sub);
      nodes.push({ id: `rs1:${repo}:dir:${sub}`, labels: ["Directory"], props: { name: `mod${s}`, path: sub } });
    }
  }

  // Files → each in a directory. Symbols → each defined by a file (DEFINES).
  const filePaths: string[] = [];
  const symbolIds: string[] = [];
  const symbolLabels = ["Function", "Class", "Interface", "Variable"];
  let symbolCount = 0;
  const targetSymbols = params.symbols;

  outer: for (const dir of dirPaths) {
    for (let f = 0; f < filesPerDir; f++) {
      const path = `${dir}/file${f}.ts`;
      const fileId = `rs1:${repo}:file:${path}`;
      filePaths.push(path);
      nodes.push({ id: fileId, labels: ["File"], props: { name: `file${f}.ts`, path } });
      edges.push({ from: `rs1:${repo}:dir:${dir}`, type: "CONTAINS", to: fileId, props: {} });

      // Symbols per file (a small spread, deterministic).
      const perFile = 3 + Math.floor(rng() * 6);
      for (let k = 0; k < perFile; k++) {
        if (symbolCount >= targetSymbols) break outer;
        const label = symbolLabels[Math.floor(rng() * symbolLabels.length)]!;
        const name = `sym${symbolCount}`;
        const id = `rs1:${repo}:sym:${path}#${name}@${k}`;
        nodes.push({
          id,
          labels: [label],
          props: {
            name,
            qualified_name: `${path}::${name}`,
            file_path: path,
            start_line: k * 5 + 1,
            end_line: k * 5 + 4,
            language: "typescript",
            content_hash: `h${symbolCount}`,
          },
        });
        edges.push({ from: fileId, type: "DEFINES", to: id, props: {} });
        symbolIds.push(id);
        symbolCount++;
      }
    }
  }

  // Relationship edges: random-but-seeded symbol→symbol typed edges. Endpoints
  // are biased toward "nearby" symbols (small index window) so degree is
  // realistic rather than uniformly dense.
  const n = symbolIds.length;
  if (n > 1) {
    const window = Math.max(8, Math.floor(n / 50));
    for (let e = 0; e < params.relEdges; e++) {
      const a = Math.floor(rng() * n);
      const off = 1 + Math.floor(rng() * window);
      const b = (a + off) % n;
      if (a === b) continue;
      const type = REL_TYPES[Math.floor(rng() * REL_TYPES.length)]!;
      const conf = 0.5 + rng() * 0.5;
      edges.push({
        from: symbolIds[a]!,
        to: symbolIds[b]!,
        type,
        props: {
          confidence: conf,
          resolution: conf > 0.9 ? "exact" : conf > 0.7 ? "name_match" : "ambiguous",
        },
      });
    }
  }

  return { nodes, edges };
}
