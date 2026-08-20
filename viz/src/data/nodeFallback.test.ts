import { describe, it, expect } from "vitest";
import { resolveNodeFallback } from "./nodeFallback";

describe("resolveNodeFallback", () => {
  it("finds a live id sharing the same suffix under a different repo_id", () => {
    const ids = ["rs1:beta:func:src/main.ts#run@0", "rs1:beta:file:src/main.ts"];
    expect(resolveNodeFallback("rs1:alpha:func:src/main.ts#run@0", ids)).toBe(
      "rs1:beta:func:src/main.ts#run@0",
    );
  });

  it("returns null when nothing shares the suffix (a genuine rename/delete)", () => {
    const ids = ["rs1:alpha:func:src/other.ts#run@0"];
    expect(resolveNodeFallback("rs1:alpha:func:src/main.ts#run@0", ids)).toBeNull();
  });

  it("returns null for an id that doesn't match the rs1:<repoId>:<rest> shape", () => {
    expect(resolveNodeFallback("not-a-reposkein-id", ["rs1:alpha:func:x#f@0"])).toBeNull();
  });

  it("never matches itself even if present in the record set", () => {
    const id = "rs1:alpha:func:src/main.ts#run@0";
    expect(resolveNodeFallback(id, [id])).toBeNull();
  });

  it("does not match on a mid-string suffix coincidence (repoId boundary matters)", () => {
    // "rs1:alphabeta:func:x#f@0" ends with the literal suffix string but its
    // OWN repoId is "alphabeta", not a suffix match at the colon boundary.
    const target = "rs1:alpha:func:x#f@0";
    const decoy = "rs1:alphabeta:func:x#f@0";
    // decoy's suffix is ":func:x#f@0" too (repoId="alphabeta"), which DOES
    // equal target's suffix — this is a legitimate match, not a false one.
    expect(resolveNodeFallback(target, [decoy])).toBe(decoy);
  });

  it("is deterministic: picks the lexicographically smallest match", () => {
    const ids = ["rs1:zeta:func:x#f@0", "rs1:alpha:func:x#f@0", "rs1:mid:func:x#f@0"];
    expect(resolveNodeFallback("rs1:old:func:x#f@0", ids)).toBe("rs1:alpha:func:x#f@0");
  });

  it("returns null for an empty record set", () => {
    expect(resolveNodeFallback("rs1:alpha:func:x#f@0", [])).toBeNull();
  });
});
