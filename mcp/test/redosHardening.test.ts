import { describe, expect, it } from "vitest";
import { bearerFromAuthHeader } from "../src/serve/tokens.js";
import { agentSlug } from "../src/store/sidecar.js";

/** CodeQL js/polynomial-redos regressions: both call sites take
 *  attacker-influenced strings (Authorization header; REPOSKEIN_AGENT env). */
describe("ReDoS hardening", () => {
  it("bearerFromAuthHeader handles a pathological long-space header in linear time", () => {
    const evil = "Bearer" + " ".repeat(500_000) + "\n";
    const t0 = Date.now();
    expect(bearerFromAuthHeader(evil)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("bearerFromAuthHeader keeps accepting ordinary Bearer headers", () => {
    expect(bearerFromAuthHeader("Bearer abc123")).toBe("abc123");
    expect(bearerFromAuthHeader("bearer\ttok")).toBe("tok");
    expect(bearerFromAuthHeader("Bearer   spaced   ")).toBe("spaced");
    expect(bearerFromAuthHeader("Bearerabc")).toBeNull();
    expect(bearerFromAuthHeader("Bearer   ")).toBeNull();
    expect(bearerFromAuthHeader("Bearer a\nb")).toBeNull();
    expect(bearerFromAuthHeader(undefined)).toBeNull();
  });

  it("agentSlug handles an adversarially long REPOSKEIN_AGENT in linear time", () => {
    const evil = ".".repeat(2_000_000) + "x";
    const t0 = Date.now();
    const out = agentSlug(evil);
    expect(Date.now() - t0).toBeLessThan(200);
    // The raw value is capped before cleaning, so the trailing "x" beyond the
    // cap never survives — a pure run of dots trims to the fallback.
    expect(out).toBe("agent");
  });

  it("agentSlug keeps ordinary slugs identical", () => {
    expect(agentSlug("Claude Code 4.5")).toBe("claude-code-4.5");
    expect(agentSlug("--weird..name--")).toBe("weird..name");
    expect(agentSlug(undefined)).toBe("agent");
  });
});
