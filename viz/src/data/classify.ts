/** Test-classification heuristic — pure & deterministic.
 *
 *  The committed JSONL carries a `role` prop on some nodes ("testing" being the
 *  test signal), but most symbol nodes have no role. So we classify test-ness
 *  primarily from the file path the way an indexer would (the same conventions
 *  RepoSkein's indexer uses), with `role === "testing"` as an additional
 *  positive signal. Conventions covered:
 *    - *_test.* / *_tests.*            (Go, Rust, generic)
 *    - test_*.py / *_test.py           (Python / pytest / unittest)
 *    - *.test.ts / *.test.tsx / *.spec.* (JS/TS Jest/Vitest/Jasmine)
 *    - *Test.java / *Tests.java        (JUnit)
 *    - *Test.cs / *Tests.cs            (xUnit/NUnit)
 *    - a path segment named test / tests / __tests__ / spec / specs
 */

import type { NodeRecord } from "./model";

const FILE_PATTERNS: RegExp[] = [
  /(^|[/\\])test_[^/\\]*\.[^/\\]+$/i, // test_foo.py
  /_tests?\.[^/\\]+$/i, // foo_test.py, foo_tests.go, foo_test.rs
  /\.(test|spec)\.[^/\\]+$/i, // foo.test.ts, foo.spec.tsx
  /[^/\\]+Tests?\.(java|cs|kt|scala)$/i, // FooTest.java, FooTests.cs
];

const DIR_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs", "testing"]);

/** True when the given file path looks like a test file. Pure. */
export function isTestPath(filePath: string): boolean {
  if (!filePath) return false;
  for (const re of FILE_PATTERNS) if (re.test(filePath)) return true;
  // Any path segment that is a conventional test directory name.
  const segments = filePath.split(/[/\\]/);
  for (const seg of segments) {
    if (DIR_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  return false;
}

/** True when a node record represents test code. Combines the file-path
 *  heuristic with the `role === "testing"` prop signal. Pure. */
export function isTestNode(rec: Pick<NodeRecord, "filePath" | "role">): boolean {
  if (rec.role === "testing") return true;
  return isTestPath(rec.filePath);
}
