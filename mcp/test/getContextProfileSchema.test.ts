import { describe, it, expect } from "vitest";
import { z } from "zod";
import { getContextProfileInputSchema } from "../src/index.js";

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

describe("get_context_profile input schema (Gemini tool-schema safety)", () => {
  const jsonSchema = z.toJSONSchema(z.object(getContextProfileInputSchema));

  it("serialises with no anyOf or oneOf", () => {
    expect(findKey(jsonSchema, "anyOf")).toEqual([]);
    expect(findKey(jsonSchema, "oneOf")).toEqual([]);
  });

  it("exposes hops as a bounded integer (1..2)", () => {
    const hops = (
      jsonSchema as {
        properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
      }
    ).properties.hops;
    expect(["integer", "number"]).toContain(hops.type);
    expect(hops.minimum).toBe(1);
    expect(hops.maximum).toBe(2);
  });

  it("accepts hops 1, 2, and omitted; rejects 0, 3, 1.5, and non-numbers", () => {
    const schema = z.object(getContextProfileInputSchema);
    expect(schema.safeParse({ hops: 1 }).success).toBe(true);
    expect(schema.safeParse({ hops: 2 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ hops: 0 }).success).toBe(false);
    expect(schema.safeParse({ hops: 3 }).success).toBe(false);
    expect(schema.safeParse({ hops: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ hops: "1" }).success).toBe(false);
  });
});
