/** Deterministic LOD cluster-tree derivation (design §3.1).
 *
 *  Repo (galaxy) → Directory (constellation) → File (solar system) →
 *  Symbol (star), derived purely from node props + structural edges
 *  (CONTAINS / DEFINES), with a file_path-string fallback when Directory
 *  nodes or structural edges are missing (older/partial graphs).
 *
 *  Pure & deterministic: iteration follows the input order (the JSONL is
 *  already sorted by id), and no Map insertion order is relied on beyond that.
 *  Same graph in → identical tree out. */

import type { RawGraph, RawNode } from "./types";
import { str } from "./types";

export type ClusterKind = "galaxy" | "dir" | "file" | "symbol";

export interface ClusterNode {
  /** Stable cluster key (drives layout seeding + position cache). */
  key: string;
  kind: ClusterKind;
  /** Display label. */
  name: string;
  /** Parent cluster key, or null for the root galaxy. */
  parent: string | null;
  /** Child cluster keys, in deterministic (sorted) order. */
  children: string[];
  /** The underlying graph node id (symbols, files, dirs, repos), if any. */
  nodeId: string | null;
  /** Symbol-only: the graph label/kind (Function/Class/...). */
  symbolKind?: string;
}

export interface ClusterTree {
  /** Root galaxy key. */
  rootKey: string;
  /** All clusters keyed by their stable key. */
  byKey: Map<string, ClusterNode>;
  /** repoId derived from the Repository node (or from ids as a fallback). */
  repoId: string;
}

const SYMBOL_LABELS = new Set(["Function", "Class", "Interface", "Enum", "Variable"]);

function label0(n: RawNode): string {
  return n.labels[0] ?? "";
}

/** Normalizes a directory path: "." stays ".", trailing slashes trimmed. */
function dirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  if (idx < 0) return ".";
  const d = filePath.slice(0, idx);
  return d === "" ? "." : d;
}

function baseName(p: string): string {
  if (p === "." || p === "") return ".";
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}

/** Derives the repoId for a graph. Prefers the Repository node's name; falls
 *  back to the `rs1:<repo>:...` id segment of any node. */
function deriveRepoId(g: RawGraph): string {
  for (const n of g.nodes) {
    if (label0(n) === "Repository") {
      const nm = str(n.props.name);
      if (nm) return nm;
    }
  }
  for (const n of g.nodes) {
    const parts = n.id.split(":");
    if (parts.length >= 2 && parts[0] === "rs1" && parts[1]) return parts[1];
  }
  return "repo";
}

/** Builds the deterministic cluster tree for ONE repo (M1: no federation). */
export function buildClusterTree(g: RawGraph): ClusterTree {
  const repoId = deriveRepoId(g);
  const rootKey = `galaxy:${repoId}`;
  const byKey = new Map<string, ClusterNode>();

  const ensure = (c: ClusterNode): ClusterNode => {
    const existing = byKey.get(c.key);
    if (existing) return existing;
    byKey.set(c.key, c);
    return c;
  };

  // Galaxy root.
  ensure({
    key: rootKey,
    kind: "galaxy",
    name: repoId,
    parent: null,
    children: [],
    nodeId: null,
  });

  const dirKey = (path: string): string => `dir:${repoId}:${path}`;
  const fileKey = (path: string): string => `file:${repoId}:${path}`;

  // 1) Directories. Create a cluster per directory path encountered, linking
  //    each to its parent directory by longest-prefix (path-string), which is
  //    equivalent to following dir→CONTAINS→dir and works even when CONTAINS
  //    edges are absent. The root dir "." attaches to the galaxy.
  const ensureDir = (path: string): ClusterNode => {
    const key = dirKey(path);
    const existing = byKey.get(key);
    if (existing) return existing;
    const isRoot = path === ".";
    const parentPath = isRoot ? null : dirOf(path);
    const parentKey = isRoot ? rootKey : ensureDir(parentPath as string).key;
    const node = ensure({
      key,
      kind: "dir",
      name: isRoot ? repoId : baseName(path),
      parent: parentKey,
      children: [],
      nodeId: null,
    });
    return node;
  };

  // Seed dirs from explicit Directory nodes first (gives them their nodeId).
  for (const n of g.nodes) {
    if (label0(n) !== "Directory") continue;
    const path = str(n.props.path) ?? ".";
    const d = ensureDir(path);
    d.nodeId = n.id;
  }

  // 2) Files → attach to the directory matching dirname of their path.
  const fileNodeId = new Map<string, string>(); // filePath -> file cluster key
  for (const n of g.nodes) {
    if (label0(n) !== "File") continue;
    const path = str(n.props.path) ?? str(n.props.file_path);
    if (path === null) continue;
    const parentDir = ensureDir(dirOf(path)); // fallback derives the dir chain
    const key = fileKey(path);
    ensure({
      key,
      kind: "file",
      name: baseName(path),
      parent: parentDir.key,
      children: [],
      nodeId: n.id,
    });
    fileNodeId.set(path, key);
  }

  // 3) Symbols → attach to their File. Prefer DEFINES (file/class → symbol);
  //    fall back to file_path match. Class methods (Class→DEFINES→Function)
  //    still attach to the file solar-system in M1 (satellite nesting deferred).
  const symbolById = new Map<string, RawNode>();
  for (const n of g.nodes) {
    if (SYMBOL_LABELS.has(label0(n))) symbolById.set(n.id, n);
  }

  // Map a symbol to its owning file cluster key via DEFINES from a File node,
  // or transitively via a containing Class that itself maps to a file.
  const fileByNodeId = new Map<string, string>(); // node id -> file cluster key
  for (const n of g.nodes) {
    if (label0(n) === "File") {
      const path = str(n.props.path) ?? str(n.props.file_path);
      if (path !== null) fileByNodeId.set(n.id, fileKey(path));
    }
  }

  const attachedSymbol = new Set<string>();
  const attachSymbol = (n: RawNode, parentKey: string): void => {
    if (attachedSymbol.has(n.id)) return;
    attachedSymbol.add(n.id);
    ensure({
      key: n.id, // a star's stable key is its own node id (design §3.1.5)
      kind: "symbol",
      name: str(n.props.name) ?? str(n.props.qualified_name) ?? n.id,
      parent: parentKey,
      children: [],
      nodeId: n.id,
      symbolKind: label0(n),
    });
  };

  // 3a) DEFINES edges (structural) from a File → symbol.
  for (const e of g.edges) {
    if (e.type !== "DEFINES") continue;
    const sym = symbolById.get(e.to);
    if (!sym) continue;
    const fileKeyForFrom = fileByNodeId.get(e.from);
    if (fileKeyForFrom && byKey.has(fileKeyForFrom)) {
      attachSymbol(sym, fileKeyForFrom);
    }
  }

  // 3b) Fallback: any unattached symbol by its file_path prop.
  for (const n of symbolById.values()) {
    if (attachedSymbol.has(n.id)) continue;
    const fp = str(n.props.file_path);
    if (fp === null) continue;
    let key = fileNodeId.get(fp);
    if (!key) {
      // No File node for this path — synthesize the file (+dir chain).
      const parentDir = ensureDir(dirOf(fp));
      key = fileKey(fp);
      ensure({
        key,
        kind: "file",
        name: baseName(fp),
        parent: parentDir.key,
        children: [],
        nodeId: null,
      });
      fileNodeId.set(fp, key);
    }
    attachSymbol(n, key);
  }

  // 4) Populate children deterministically (sorted by key) from parent links.
  for (const c of byKey.values()) {
    if (c.parent) {
      const p = byKey.get(c.parent);
      if (p) p.children.push(c.key);
    }
  }
  for (const c of byKey.values()) {
    c.children.sort();
  }

  return { rootKey, byKey, repoId };
}

/** Flattens the tree into a deterministically-ordered list (depth-first,
 *  children sorted). The order is the canonical iteration order used for
 *  layout buffers so positions are reproducible. */
export function flattenTree(tree: ClusterTree): ClusterNode[] {
  const out: ClusterNode[] = [];
  const visit = (key: string): void => {
    const c = tree.byKey.get(key);
    if (!c) return;
    out.push(c);
    for (const child of c.children) visit(child);
  };
  visit(tree.rootKey);
  return out;
}
