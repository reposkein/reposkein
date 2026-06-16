import type { GraphStore } from "../store/GraphStore.js";

/**
 * Mirrors the Rust indexer's `role_for` test classification (classify.rs).
 * A file is a test file if:
 *  - any lowercased path segment equals "test" or "tests", or ends with ".tests"
 *  - the lowercased basename starts with "test_"
 *  - the basename contains "_test.", ".test.", ".spec.", or ".tests."
 *  - the original (case-preserving) basename ends with exactly "Test.java",
 *    "Tests.java", or "Tests.cs" (case-sensitive, language-specific — Rust rule)
 *
 * Intentionally NOT matched (no false positives):
 *  - "LoadTest.py" — not a Java/C# file; Rust only checks .java/.cs
 *  - "FooTest.ts"  — same; TypeScript uses .test.ts or .spec.ts convention
 *  - "contest_results.py" — "contest" starts with "cont", not "test_"
 */
export function isTestPath(filePath: string): boolean {
  const p = filePath.toLowerCase();
  const basename = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  const origBasename = filePath.includes("/")
    ? filePath.slice(filePath.lastIndexOf("/") + 1)
    : filePath;

  // Any path segment == "test" | "tests", or ends with ".tests"
  const inTestDir = p.split("/").some((seg) => seg === "test" || seg === "tests" || seg.endsWith(".tests"));
  if (inTestDir) return true;

  // Basename test_ prefix
  if (basename.startsWith("test_")) return true;

  // Basename contains _test., .test., .spec., .tests.
  if (
    basename.includes("_test.") ||
    basename.includes(".test.") ||
    basename.includes(".spec.") ||
    basename.includes(".tests.")
  ) {
    return true;
  }

  // Case-sensitive: only the exact language-specific suffixes that Rust checks.
  // FooTest.java / FooTests.java (Java convention)
  // FooTests.cs (C# convention — paired with the .tests. segment check above for Foo.Tests.cs)
  if (
    origBasename.endsWith("Test.java") ||
    origBasename.endsWith("Tests.java") ||
    origBasename.endsWith("Tests.cs")
  ) {
    return true;
  }

  return false;
}

export interface ImpactRow {
  node_id: string;
  qualified_name: string;
  file_path: string;
  depth: number;
  is_test: boolean;
}

export interface ImpactResult {
  target: { node_id: string; qualified_name: string; file_path: string };
  depth: number;
  impacted: ImpactRow[];        // non-test transitive callers, sorted (depth asc, id asc)
  covering_tests: ImpactRow[];  // transitive callers whose file is a test, sorted
  counts: { impacted: number; covering_tests: number; truncated: boolean };
}

/**
 * BFS over callers to bounded depth with a maxNodes cap.
 * NeighborRow does not carry file_path, so we fetch it via store.getNode().
 * Deterministic ordering: depth asc, then node_id asc.
 */
export async function computeImpact(
  store: GraphStore,
  repoIds: string[],
  targetId: string,
  targetQN: string,
  targetFile: string,
  opts: { depth: number; maxNodes: number },
): Promise<ImpactResult> {
  const { depth: maxDepth, maxNodes } = opts;

  // visited: node_id → { qualifiedName, filePath, depth }
  const visited = new Map<string, { qualified_name: string; file_path: string; depth: number }>();
  // frontier: array of node_ids at the current level
  let frontier: string[] = [targetId];
  // Mark the target as visited at depth 0 (excluded from output)
  visited.set(targetId, { qualified_name: targetQN, file_path: targetFile, depth: 0 });

  let truncated = false;

  for (let currentDepth = 1; currentDepth <= maxDepth && frontier.length > 0; currentDepth++) {
    const nextFrontier: string[] = [];

    // Collect all callers for all frontier nodes at this depth
    // Use a generous per-node limit; we dedupe globally via visited
    const PER_NODE_LIMIT = Math.max(maxNodes, 1000);

    for (const nodeId of frontier) {
      const callerRows = await store.callers(repoIds, nodeId, PER_NODE_LIMIT);

      for (const row of callerRows) {
        if (visited.has(row.id)) continue;

        // Fetch file_path via getNode (NeighborRow doesn't carry it)
        const node = await store.getNode(repoIds, row.id);
        const filePath = node?.file_path ?? "";
        const qualifiedName = node?.qualified_name ?? row.name;

        visited.set(row.id, { qualified_name: qualifiedName, file_path: filePath, depth: currentDepth });
        nextFrontier.push(row.id);

        // Check maxNodes cap (excluding the target at depth 0)
        if (visited.size - 1 >= maxNodes) {
          truncated = true;
          break;
        }
      }

      if (truncated) break;
    }

    if (truncated) break;
    frontier = nextFrontier;
  }

  // Partition visited (excluding the target) into impacted vs covering_tests
  const allRows: ImpactRow[] = [];
  for (const [nodeId, info] of visited) {
    if (nodeId === targetId) continue;
    const isTest = isTestPath(info.file_path);
    allRows.push({
      node_id: nodeId,
      qualified_name: info.qualified_name,
      file_path: info.file_path,
      depth: info.depth,
      is_test: isTest,
    });
  }

  // Deterministic ordering: depth asc, then node_id asc
  allRows.sort((a, b) => a.depth - b.depth || a.node_id.localeCompare(b.node_id));

  const impacted = allRows.filter((r) => !r.is_test);
  const covering_tests = allRows.filter((r) => r.is_test);

  return {
    target: { node_id: targetId, qualified_name: targetQN, file_path: targetFile },
    depth: maxDepth,
    impacted,
    covering_tests,
    counts: {
      impacted: impacted.length,
      covering_tests: covering_tests.length,
      truncated,
    },
  };
}
