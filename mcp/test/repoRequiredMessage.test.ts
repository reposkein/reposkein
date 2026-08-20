import { describe, it, expect } from "vitest";
import { repoRequiredMessage } from "../src/index.js";

describe("repoRequiredMessage", () => {
  it("points at list_repos and select_repo (not just the env var) on ambiguity", () => {
    const msg = repoRequiredMessage({
      repoPath: undefined,
      source: "none",
      candidates: ["/ws/repo-a", "/ws/repo-b"],
    });
    expect(msg).toContain("/ws/repo-a");
    expect(msg).toContain("/ws/repo-b");
    expect(msg).toMatch(/list_repos/);
    expect(msg).toMatch(/select_repo/);
  });

  it("mentions list_repos as a diagnostic when nothing resolved at all", () => {
    const msg = repoRequiredMessage({ repoPath: undefined, source: "none" });
    expect(msg).toMatch(/list_repos/);
    expect(msg).toMatch(/reposkein-mcp init/);
  });
});
