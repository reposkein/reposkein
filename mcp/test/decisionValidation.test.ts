import { describe, it, expect } from "vitest";
import { sanitizeDecisionFields, DECISION_FIELD_CAPS } from "../src/guard/decisionValidation.js";

const VALID = {
  title: "Use file-per-decision storage",
  context: "Single JSONL files conflict on forges.",
  decision: "We will store one JSON file per decision.",
};

describe("sanitizeDecisionFields", () => {
  it("accepts plain-text fields and trims them", () => {
    const r = sanitizeDecisionFields({ ...VALID, context: "  padded  " });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.context).toBe("padded");
      expect(r.value.title).toBe(VALID.title);
      expect(r.value.consequences).toBeUndefined();
    }
  });

  it("rejects a missing required field", () => {
    const r = sanitizeDecisionFields({ ...VALID, decision: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("decision");
  });

  it("rejects code fences and markdown links in any field", () => {
    expect(sanitizeDecisionFields({ ...VALID, context: "run ```rm -rf```" }).ok).toBe(false);
    expect(sanitizeDecisionFields({ ...VALID, alternatives: "[x](http://evil)" }).ok).toBe(false);
  });

  it("enforces per-field caps", () => {
    const r = sanitizeDecisionFields({ ...VALID, title: "t".repeat(DECISION_FIELD_CAPS.title + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("title");
    expect(
      sanitizeDecisionFields({ ...VALID, context: "c".repeat(DECISION_FIELD_CAPS.context) }).ok
    ).toBe(true);
  });

  it("strips control characters", () => {
    const r = sanitizeDecisionFields({ ...VALID, decision: "We\x00 will\x07 do X." });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision).toBe("We will do X.");
  });
});
