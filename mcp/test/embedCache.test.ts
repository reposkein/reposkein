/**
 * The document string: what gets embedded, and the hash that decides when to
 * re-embed it. Storage moved to vectorStore.ts and orchestration to
 * corpusVectors.ts, each with their own tests.
 *
 * Offline — no API, no network.
 */

import { describe, it, expect } from "vitest";
import {
  buildDocString,
  docCharBudget,
  DEFAULT_DOC_CHAR_BUDGET,
  sha256,
  sanitizeModelId,
} from "../src/embed/cache.js";
import type { CorpusNode } from "../src/store/GraphStore.js";

function cn(
  id: string,
  qn: string,
  signature = "",
  summary = "",
  file_path = "src/a.ts"
): CorpusNode {
  return {
    id,
    kind: "Function",
    name: qn.split(".").pop() ?? qn,
    qualified_name: qn,
    signature,
    summary,
    file_path,
    repo_id: "testrepo",
  };
}

const NODE_A = cn(
  "id:1",
  "auth.validateToken",
  "(token: string): boolean",
  "Validates a JWT",
  "src/auth.ts"
);
const NODE_C = cn("id:3", "util.toString", "", "", "src/util.ts");

describe("buildDocString", () => {
  it("includes qualified_name, signature, summary, file_path", () => {
    const doc = buildDocString(NODE_A);
    expect(doc).toContain("auth.validateToken");
    expect(doc).toContain("(token: string): boolean");
    expect(doc).toContain("Validates a JWT");
    expect(doc).toContain("src/auth.ts");
  });

  it("omits empty signature and summary", () => {
    expect(buildDocString(NODE_C)).toBe("util.toString\nsrc/util.ts");
  });

  it("is deterministic across calls", () => {
    expect(buildDocString(NODE_A)).toBe(buildDocString(NODE_A));
  });
});

describe("buildDocString length budget", () => {
  // The bundled embed server rejects an over-long input with 413, and ONE
  // rejected document fails the whole embed call — so semantic_find would fall
  // back to lexical and keep falling back, because the offending document is
  // never embedded and every later attempt reissues it.
  const long = (n: number) => "s".repeat(n);

  it("never emits a document longer than the budget", () => {
    const node = cn("id:x", "pkg.fn", "(a: number)", long(50_000), "src/x.ts");
    expect(buildDocString(node, 8000).length).toBeLessThanOrEqual(8000);
  });

  it("keeps the identifiers and drops summary prose to fit", () => {
    const node = cn("id:x", "pkg.veryDistinctName", "(a: number)", long(50_000), "src/x.ts");
    const doc = buildDocString(node, 8000);
    expect(doc).toContain("pkg.veryDistinctName");
    expect(doc).toContain("(a: number)");
    expect(doc).toContain("src/x.ts");
  });

  it("leaves a document that already fits completely alone", () => {
    const node = cn("id:x", "pkg.fn", "(a: number)", "short summary", "src/x.ts");
    expect(buildDocString(node, 8000)).toBe(buildDocString(node, 1_000_000));
  });

  it("is still deterministic once truncated", () => {
    const node = cn("id:x", "pkg.fn", "()", long(20_000), "src/x.ts");
    expect(buildDocString(node, 8000)).toBe(buildDocString(node, 8000));
  });

  it("survives a node whose own name and path exceed the budget", () => {
    const node = cn("id:x", long(9000), "", "", long(9000));
    expect(buildDocString(node, 8000).length).toBe(8000);
  });
});

describe("docCharBudget", () => {
  it("defaults to the server's own cap", () => {
    expect(docCharBudget({})).toBe(DEFAULT_DOC_CHAR_BUDGET);
  });

  it("follows an explicitly configured server cap", () => {
    expect(docCharBudget({ REPOSKEIN_EMBED_MAX_INPUT_CHARS: "2000" })).toBe(2000);
  });

  it("ignores a malformed value rather than emitting unbounded documents", () => {
    expect(docCharBudget({ REPOSKEIN_EMBED_MAX_INPUT_CHARS: "lots" })).toBe(
      DEFAULT_DOC_CHAR_BUDGET
    );
    expect(docCharBudget({ REPOSKEIN_EMBED_MAX_INPUT_CHARS: "0" })).toBe(DEFAULT_DOC_CHAR_BUDGET);
  });
});

describe("sha256", () => {
  it("returns a 64-char hex string", () => {
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
  });

  it("produces different hashes for different inputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

describe("sanitizeModelId", () => {
  it("replaces forward slashes", () => {
    expect(sanitizeModelId("voyageai/voyage-4-nano")).not.toContain("/");
  });

  it("replaces backslashes", () => {
    expect(sanitizeModelId("some\\model")).not.toContain("\\");
  });

  it("leaves safe characters unchanged", () => {
    expect(sanitizeModelId("voyage-code-3")).toBe("voyage-code-3");
  });

  it("replaces multiple unsafe chars in sequence", () => {
    const result = sanitizeModelId("org/model:version");
    expect(result).not.toContain("/");
    expect(result).not.toContain(":");
  });
});
