import { describe, it, expect } from "vitest";
import { colorEnabled, styler } from "../src/cli/ansi.js";

describe("colorEnabled", () => {
  it("is enabled on a TTY with no NO_COLOR", () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
  });
  it("is disabled when not a TTY", () => {
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({}, {})).toBe(false);
  });
  it("is disabled when NO_COLOR is set, even on a TTY", () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
  });
});

describe("styler", () => {
  it("wraps text with ANSI escapes when enabled", () => {
    const s = styler(true);
    expect(s.teal("x")).toMatch(/\x1b\[.*x.*\x1b\[0m/);
    expect(s.amber("y")).toMatch(/\x1b\[.*y.*\x1b\[0m/);
    expect(s.bold("z")).toMatch(/\x1b\[.*z.*\x1b\[0m/);
  });
  it("returns plain text when disabled", () => {
    const s = styler(false);
    expect(s.teal("x")).toBe("x");
    expect(s.amber("y")).toBe("y");
    expect(s.bold("z")).toBe("z");
    expect(s.dim("w")).toBe("w");
  });
});
