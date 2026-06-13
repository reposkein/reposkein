import { describe, it, expect } from "vitest";
import { assertReadOnly } from "../src/guard/readonly.js";

describe("assertReadOnly", () => {
  it("allows plain reads", () => {
    expect(() => assertReadOnly("MATCH (n:File) RETURN n LIMIT 10")).not.toThrow();
    expect(() => assertReadOnly("MATCH (a)-[:CALLS]->(b) RETURN a,b")).not.toThrow();
  });

  it("allows write keywords inside string literals", () => {
    expect(() =>
      assertReadOnly("MATCH (n:File) WHERE n.path = 'src/create_user.py' RETURN n")
    ).not.toThrow();
    expect(() =>
      assertReadOnly('MATCH (n) WHERE n.name = "DELETE" RETURN n')
    ).not.toThrow();
  });

  it("rejects write clauses", () => {
    for (const q of [
      "MATCH (n) DELETE n",
      "CREATE (n:Foo)",
      "MATCH (n:File) SET n.x = 1",
      "MERGE (n:Foo {id:'x'})",
      "MATCH (n) REMOVE n.prop",
      "DROP INDEX foo",
      "MATCH (n) DETACH DELETE n",
    ]) {
      expect(() => assertReadOnly(q), q).toThrow(/read-only/i);
    }
  });

  it("rejects LOAD CSV, unknown/write procedures, and multiple statements", () => {
    expect(() => assertReadOnly("LOAD CSV FROM 'file:///x.csv' AS row RETURN row")).toThrow();
    expect(() => assertReadOnly("CALL apoc.create.node(['X'], {}) YIELD node RETURN node")).toThrow();
    expect(() => assertReadOnly("CALL apoc.atomic.add(n, 'x', 1)")).toThrow();
    expect(() => assertReadOnly("CALL custom.write()")).toThrow();
    expect(() => assertReadOnly("CALL dbms.security.createUser('x','y')")).toThrow();
    expect(() => assertReadOnly("MATCH (n) RETURN n; CREATE (m:Evil)")).toThrow();
  });

  it("allows read-only procedures on the allowlist and CALL subqueries", () => {
    expect(() => assertReadOnly("CALL db.labels() YIELD label RETURN label")).not.toThrow();
    expect(() =>
      assertReadOnly("MATCH (a) CALL apoc.path.expand(a, '>', '', 1, 2) YIELD path RETURN path")
    ).not.toThrow();
    expect(() =>
      assertReadOnly("CALL { MATCH (n:File) RETURN n LIMIT 1 } RETURN n")
    ).not.toThrow();
  });
});
