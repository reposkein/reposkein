import { describe, it, expect } from "vitest";
import { shortSha, relativeAge, badgeInfo, teamConstellationHref } from "./badge";

describe("shortSha", () => {
  it("truncates to 7 chars", () => {
    expect(shortSha("abcdef1234567890")).toBe("abcdef1");
  });
  it("passes short shas through unchanged", () => {
    expect(shortSha("abc")).toBe("abc");
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");

  it("just now for sub-5s", () => {
    expect(relativeAge("2026-08-20T11:59:58.000Z", now)).toBe("just now");
  });
  it("seconds", () => {
    expect(relativeAge("2026-08-20T11:59:30.000Z", now)).toBe("30s ago");
  });
  it("minutes", () => {
    expect(relativeAge("2026-08-20T11:45:00.000Z", now)).toBe("15m ago");
  });
  it("hours", () => {
    expect(relativeAge("2026-08-20T06:00:00.000Z", now)).toBe("6h ago");
  });
  it("days", () => {
    expect(relativeAge("2026-08-15T12:00:00.000Z", now)).toBe("5d ago");
  });
  it("months", () => {
    expect(relativeAge("2026-05-20T12:00:00.000Z", now)).toBe("3mo ago");
  });
  it("years", () => {
    expect(relativeAge("2024-08-20T12:00:00.000Z", now)).toBe("2y ago");
  });
  it("unknown age for unparseable input", () => {
    expect(relativeAge("not-a-date", now)).toBe("unknown age");
  });
  it("never goes negative for a future timestamp (clock skew)", () => {
    expect(relativeAge("2026-08-21T12:00:00.000Z", now)).toBe("just now");
  });
});

describe("badgeInfo", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");

  it("returns null when meta is null", () => {
    expect(badgeInfo(null, now)).toBeNull();
  });

  it("returns null when commitSha is missing", () => {
    expect(badgeInfo({ commitSha: null, builtAt: "2026-08-20T00:00:00.000Z", repoUrl: "https://x/y" }, now)).toBeNull();
  });

  it("builds label + commit link when all fields present", () => {
    const info = badgeInfo(
      { commitSha: "abcdef1234567890", builtAt: "2026-08-20T06:00:00.000Z", repoUrl: "https://github.com/o/r" },
      now,
    );
    expect(info).toEqual({
      label: "graph @ abcdef1 · 6h ago",
      href: "https://github.com/o/r/commit/abcdef1234567890",
    });
  });

  it("omits the age segment when builtAt is null", () => {
    const info = badgeInfo({ commitSha: "abc1234", builtAt: null, repoUrl: "https://github.com/o/r" }, now);
    expect(info?.label).toBe("graph @ abc1234");
  });

  it("has a null href when repoUrl is missing (badge still renders, just not linked)", () => {
    const info = badgeInfo({ commitSha: "abc1234", builtAt: "2026-08-20T06:00:00.000Z", repoUrl: null }, now);
    expect(info?.href).toBeNull();
    expect(info?.label).toBe("graph @ abc1234 · 6h ago");
  });
});

describe("teamConstellationHref", () => {
  it("returns null when meta is null", () => {
    expect(teamConstellationHref(null)).toBeNull();
  });

  it("returns null when pagesUrl is absent (older manifests without the field)", () => {
    expect(teamConstellationHref({ commitSha: null, builtAt: null, repoUrl: null })).toBeNull();
  });

  it("returns null when pagesUrl is explicitly null (no [team] section)", () => {
    expect(teamConstellationHref({ commitSha: null, builtAt: null, repoUrl: null, pagesUrl: null })).toBeNull();
  });

  it("returns null for a blank/whitespace-only pagesUrl", () => {
    expect(teamConstellationHref({ commitSha: null, builtAt: null, repoUrl: null, pagesUrl: "   " })).toBeNull();
  });

  it("returns the trimmed pagesUrl when set", () => {
    expect(
      teamConstellationHref({
        commitSha: null,
        builtAt: null,
        repoUrl: null,
        pagesUrl: "  https://reposkein.github.io/example  ",
      }),
    ).toBe("https://reposkein.github.io/example");
  });
});
