import { describe, it, expect } from "vitest";
import { applyCaps } from "../src/guard/caps.js";

describe("applyCaps", () => {
  it("passes small results through untruncated", () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const r = applyCaps(rows, 200, 64 * 1024);
    expect(r.rows).toEqual(rows);
    expect(r.truncated).toBe(false);
  });

  it("truncates by row count", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ i }));
    const r = applyCaps(rows, 200, 64 * 1024);
    expect(r.rows.length).toBe(200);
    expect(r.truncated).toBe(true);
  });

  it("truncates by serialized byte budget", () => {
    const big = "x".repeat(1000);
    const rows = Array.from({ length: 100 }, () => ({ big }));
    const r = applyCaps(rows, 1000, 5 * 1024); // ~5KB budget
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBeLessThan(100);
  });
});
