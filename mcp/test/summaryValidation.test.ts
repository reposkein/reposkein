import { describe, it, expect } from "vitest";
import { sanitizeSummary, neutralizeSummary } from "../src/guard/summaryValidation.js";

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

describe("neutralizeSummary", () => {
  it("returns null unchanged for null", () => {
    expect(neutralizeSummary(null)).toBeNull();
  });
  it("passes clean text through (trimmed)", () => {
    expect(neutralizeSummary("  Rotates the auth token.  ")).toBe("Rotates the auth token.");
  });
  it("strips code fences", () => {
    expect(neutralizeSummary("does x ```rm -rf``` end")).toBe("does x rm -rf end");
  });
  it("unwraps markdown links to their text", () => {
    expect(neutralizeSummary("see [the docs](http://evil.test)")).toBe("see the docs");
  });
  it("strips control chars", () => {
    expect(neutralizeSummary("ab\x01cd")).toBe("abcd");
  });
  it("returns null when nothing readable remains", () => {
    expect(neutralizeSummary("   ")).toBeNull();
  });
});
