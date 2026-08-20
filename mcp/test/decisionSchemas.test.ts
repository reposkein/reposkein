import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  getDecisionInputSchema,
  listDecisionsInputSchema,
  reaffirmDecisionInputSchema,
  recordDecisionInputSchema,
  setDecisionStatusInputSchema,
} from "../src/index.js";

function findKey(node: unknown, key: string): unknown[] {
  const hits: unknown[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const v of n) walk(v);
    } else if (n && typeof n === "object") {
      for (const [k, v] of Object.entries(n)) {
        if (k === key) hits.push(v);
        walk(v);
      }
    }
  };
  walk(node);
  return hits;
}

const SCHEMAS = {
  record_decision: recordDecisionInputSchema,
  set_decision_status: setDecisionStatusInputSchema,
  reaffirm_decision: reaffirmDecisionInputSchema,
  list_decisions: listDecisionsInputSchema,
  get_decision: getDecisionInputSchema,
};

describe("decision tool input schemas (Gemini tool-schema safety)", () => {
  for (const [name, shape] of Object.entries(SCHEMAS)) {
    it(`${name} serialises with no anyOf or oneOf`, () => {
      const jsonSchema = z.toJSONSchema(z.object(shape));
      expect(findKey(jsonSchema, "anyOf")).toEqual([]);
      expect(findKey(jsonSchema, "oneOf")).toEqual([]);
    });
  }

  it("list_decisions limit is a bounded integer (1..50)", () => {
    const schema = z.object(listDecisionsInputSchema);
    expect(schema.safeParse({ limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ limit: 50 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 51 }).success).toBe(false);
    expect(schema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  it("record_decision rejects an unknown status and oversized arrays", () => {
    const schema = z.object(recordDecisionInputSchema);
    const base = { title: "t", context: "c", decision: "d" };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, status: "superseded" }).success).toBe(false);
    expect(schema.safeParse({ ...base, supersedes: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
  });
});
