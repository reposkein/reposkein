import { describe, it, expect } from "vitest";
import { buildInlinedContext } from "../src/profile/inline.js";
import type { ProfileTarget, NeighborEntry } from "../src/profile/types.js";

const target: ProfileTarget = {
  id: "t", name: "SessionManager.refresh", file_path: "src/auth/session.py",
  lines: [142, 188], summary: null, stale: false,
};

describe("buildInlinedContext", () => {
  it("flags an unsummarized target for enrichment", () => {
    const s = buildInlinedContext(target, [], []);
    expect(s).toContain("SessionManager.refresh");
    expect(s).toContain("src/auth/session.py:142-188");
    expect(s).toMatch(/no summary yet/i);
  });

  it("names callers and callees, and caveats low-confidence edges", () => {
    const upstream: NeighborEntry[] = [
      { id: "u", name: "AuthMiddleware.handle", summary: "handles auth", stale: false, needs_enrichment: false, resolution: "exact" },
    ];
    const downstream: NeighborEntry[] = [
      { id: "d1", name: "TokenStore.rotate", summary: null, stale: false, needs_enrichment: true, resolution: "exact", confidence: 1 },
      { id: "d2", name: "EventBus.emit", summary: null, stale: false, needs_enrichment: true, resolution: "name_match", confidence: 0.62 },
    ];
    const s = buildInlinedContext(target, upstream, downstream);
    expect(s).toContain("Called by AuthMiddleware.handle");
    expect(s).toContain("TokenStore.rotate");
    expect(s).toMatch(/EventBus\.emit.*name_match.*0\.62.*verify/i);
  });
});
