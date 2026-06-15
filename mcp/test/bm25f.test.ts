import { describe, it, expect } from "vitest";
import { tokenize, rankCorpus } from "../src/search/bm25f.js";
import type { CorpusNode } from "../src/store/GraphStore.js";

const n = (id: string, qn: string, name: string, summary = "", sig = "", fp = "a.ts"): CorpusNode =>
  ({ id, kind: "Function", name, qualified_name: qn, signature: sig, summary, file_path: fp, repo_id: "r" });

describe("tokenize", () => {
  it("splits camelCase + snake_case, lowercases, drops len-1", () => {
    expect(tokenize("getUserById")).toEqual(["get", "user", "by", "id"]);
    expect(tokenize("parse_jwt_token")).toEqual(["parse", "jwt", "token"]);
  });

  it("splits on non-alphanumeric boundaries", () => {
    expect(tokenize("auth/login.ts")).toEqual(["auth", "login", "ts"]);
    expect(tokenize("foo.bar#baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("handles PascalCase and acronyms", () => {
    expect(tokenize("HTTPServer")).toEqual(["http", "server"]);
    expect(tokenize("XMLParser")).toEqual(["xml", "parser"]);
  });

  it("drops length-1 tokens", () => {
    const result = tokenize("a.b.c.def");
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
    expect(result).not.toContain("c");
    expect(result).toContain("def");
  });
});

describe("rankCorpus", () => {
  const corpus = [
    n("id:a", "auth.validateToken", "validateToken", "Validates a JWT auth token"),
    n("id:b", "billing.charge", "charge", "Charges a customer card"),
    n("id:c", "util.toString", "toString"),
  ];

  it("ranks the name/summary match first and is deterministic", () => {
    const r1 = rankCorpus(corpus, "validate token", 10);
    const r2 = rankCorpus(corpus, "validate token", 10);
    expect(r1.map(x => x.node.id)).toEqual(r2.map(x => x.node.id)); // deterministic
    expect(r1[0]!.node.id).toBe("id:a");
    expect(r1[0]!.matched.sort()).toEqual(["token", "validate"]);
  });

  it("breaks score ties by id ascending", () => {
    const tie = [n("id:z", "x.run", "run"), n("id:a", "x.run", "run")];
    expect(rankCorpus(tie, "run", 10).map(x => x.node.id)).toEqual(["id:a", "id:z"]);
  });

  it("respects limit", () => {
    expect(rankCorpus(corpus, "a", 1).length).toBeLessThanOrEqual(1);
  });

  it("returns empty for empty corpus", () => {
    expect(rankCorpus([], "query", 10)).toEqual([]);
  });

  it("returns empty for empty query", () => {
    expect(rankCorpus(corpus, "", 10)).toEqual([]);
  });

  it("qualified_name hit outranks summary-only hit", () => {
    const c = [
      n("id:x", "auth.login", "login", "handles user sessions"),
      n("id:y", "session.manage", "manage", "handles auth login flow"),
    ];
    const r = rankCorpus(c, "login", 10);
    // id:x has "login" in both qualified_name (weight 10) and name (weight 8); id:y only in summary (weight 4)
    expect(r[0]!.node.id).toBe("id:x");
  });

  it("includes matched token list sorted", () => {
    const r = rankCorpus(corpus, "validate token", 10);
    expect(r[0]!.matched).toEqual(["token", "validate"]);
  });

  it("scores are rounded (deterministic across runs)", () => {
    const r1 = rankCorpus(corpus, "jwt auth", 10);
    const r2 = rankCorpus(corpus, "jwt auth", 10);
    expect(r1[0]!.score).toBe(r2[0]!.score);
  });
});
