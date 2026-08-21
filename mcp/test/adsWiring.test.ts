import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpServer } from "../src/server/createMcpServer.js";
import { AD_ELIGIBLE_TOOLS } from "../src/ads/config.js";
import type { AdsHook } from "../src/ads/slot.js";

/** Records which tool registrations the sponsorship hook was applied to, so
 *  the WIRING (not just the hook's own logic) is covered: a future tool added
 *  to createMcpServer must not silently acquire an ad slot, and the one tool
 *  that has one must not silently lose it. */
function recordingHook(): AdsHook & { wrapped: string[] } {
  const wrapped: string[] = [];
  return {
    wrapped,
    withAds(tool, cb) {
      wrapped.push(tool);
      return cb;
    },
  };
}

describe("createMcpServer — sponsorship slot wiring", () => {
  it("wraps exactly the eligible tools, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "reposkein-ads-wiring-"));
    mkdirSync(join(dir, ".reposkein"), { recursive: true });
    try {
      const ads = recordingHook();
      createMcpServer({ cwd: dir, envRepoPath: dir, sessionId: "wiring-test", ads });
      expect(ads.wrapped).toEqual([...AD_ELIGIBLE_TOOLS]);
      expect(ads.wrapped).not.toContain("semantic_find");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
