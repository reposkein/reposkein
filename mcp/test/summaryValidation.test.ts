import { describe, it, expect } from "vitest";
import { sanitizeSummary } from "../src/guard/summaryValidation.js";

describe("sanitizeSummary", () => {
  it("accepts plain prose and strips control characters", () => {
    const r = sanitizeSummary("Refreshes the session token. Returns a new token.");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("Refreshes the session token. Returns a new token.");
  });

  it("preserves newlines and tabs", () => {
    const r = sanitizeSummary("line one\n\tline two");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toContain("\n");
  });

  it("rejects summaries over 1000 characters", () => {
    const r = sanitizeSummary("x".repeat(1001));
    expect(r.ok).toBe(false);
  });

  it("rejects code fences and markdown links (injection surface)", () => {
    expect(sanitizeSummary("see ```rm -rf```").ok).toBe(false);
    expect(sanitizeSummary("click [here](http://evil.test)").ok).toBe(false);
  });

  it("rejects empty/whitespace-only summaries", () => {
    expect(sanitizeSummary("   ").ok).toBe(false);
  });
});
