import { describe, it, expect } from "vitest";
import { screenshotFilename } from "./screenshotName";

describe("screenshotFilename", () => {
  it("uses the repoId as the stem", () => {
    expect(screenshotFilename("reposkein")).toBe("reposkein-reposkein.png");
  });

  it("sanitizes path separators and spaces to dashes", () => {
    expect(screenshotFilename("my org/My Repo")).toBe("reposkein-my-org-My-Repo.png");
  });

  it("trims leading/trailing dashes from sanitized junk", () => {
    expect(screenshotFilename("///weird///")).toBe("reposkein-weird.png");
  });

  it("falls back to 'repo' for undefined / empty", () => {
    expect(screenshotFilename(undefined)).toBe("reposkein-repo.png");
    expect(screenshotFilename("")).toBe("reposkein-repo.png");
    expect(screenshotFilename("@@@")).toBe("reposkein-repo.png");
  });

  it("keeps allowed chars (dot, underscore, hyphen) and caps length", () => {
    expect(screenshotFilename("a.b_c-d")).toBe("reposkein-a.b_c-d.png");
    const long = "x".repeat(200);
    const out = screenshotFilename(long);
    // stem capped at 80 chars
    expect(out).toBe(`reposkein-${"x".repeat(80)}.png`);
  });
});
