import { describe, it, expect } from "vitest";
import {
  bearerFromAuthHeader,
  loadServeTokens,
  matchServeToken,
  parseServeTokens,
} from "../src/serve/tokens.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET_A = "aaaaaaaaaaaaaaaaaaaa";
const SECRET_B = "bbbbbbbbbbbbbbbbbbbb";

describe("parseServeTokens", () => {
  it("parses name:token as read-only and name:token:write as write-capable", () => {
    const { tokens, errors } = parseServeTokens(`reader:${SECRET_A}, writer:${SECRET_B}:write`);
    expect(errors).toEqual([]);
    expect(tokens).toEqual([
      { name: "reader", token: SECRET_A, write: false },
      { name: "writer", token: SECRET_B, write: true },
    ]);
  });

  it("accepts newline- and whitespace-separated entries (env file / TOML paste)", () => {
    const { tokens } = parseServeTokens(`  reader:${SECRET_A}\n\twriter:${SECRET_B}:write  `);
    expect(tokens.map((t) => t.name)).toEqual(["reader", "writer"]);
  });

  it("drops a secret shorter than the minimum without granting it", () => {
    const { tokens, errors } = parseServeTokens("weak:short");
    expect(tokens).toEqual([]);
    expect(errors.join(" ")).toContain("shorter than");
  });

  it("never leaks a secret into the error strings", () => {
    const { errors } = parseServeTokens(`bad name:${SECRET_A}:oops`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).not.toContain(SECRET_A);
  });

  it("refuses a capability field other than the literal `write`", () => {
    const { tokens, errors } = parseServeTokens(`x:${SECRET_A}:admin`);
    expect(tokens).toEqual([]);
    expect(errors.join(" ")).toContain('must be "write"');
  });

  it("rejects a name with characters that could escape a file path", () => {
    const { tokens, errors } = parseServeTokens(`../../etc:${SECRET_A}`);
    expect(tokens).toEqual([]);
    expect(errors.join(" ")).toContain("name must be");
  });

  it("drops duplicate names and duplicate secrets (identity must be unambiguous)", () => {
    const dup = parseServeTokens(`a:${SECRET_A} a:${SECRET_B}`);
    expect(dup.tokens.map((t) => t.name)).toEqual(["a"]);
    expect(dup.errors.join(" ")).toContain("duplicate token name");

    const shared = parseServeTokens(`a:${SECRET_A} b:${SECRET_A}`);
    expect(shared.tokens.map((t) => t.name)).toEqual(["a"]);
    expect(shared.errors.join(" ")).toContain("already used by another name");
  });

  it("returns nothing for an empty spec", () => {
    expect(parseServeTokens("   ")).toEqual({ tokens: [], errors: [] });
  });
});

describe("bearerFromAuthHeader", () => {
  it("extracts the credential, case-insensitively on the scheme", () => {
    expect(bearerFromAuthHeader(`Bearer ${SECRET_A}`)).toBe(SECRET_A);
    expect(bearerFromAuthHeader(`bearer ${SECRET_A}`)).toBe(SECRET_A);
  });
  it("returns null for missing, non-Bearer, or empty values", () => {
    expect(bearerFromAuthHeader(undefined)).toBeNull();
    expect(bearerFromAuthHeader(`Basic ${SECRET_A}`)).toBeNull();
    expect(bearerFromAuthHeader("Bearer   ")).toBeNull();
  });
});

describe("matchServeToken", () => {
  const tokens = parseServeTokens(`reader:${SECRET_A}, writer:${SECRET_B}:write`).tokens;

  it("matches the right token and reports its capability", () => {
    expect(matchServeToken(tokens, SECRET_B)).toEqual({
      name: "writer",
      token: SECRET_B,
      write: true,
    });
  });
  it("returns null for a wrong or absent credential", () => {
    expect(matchServeToken(tokens, "cccccccccccccccccccc")).toBeNull();
    expect(matchServeToken(tokens, null)).toBeNull();
    // A prefix of a real secret must not match.
    expect(matchServeToken(tokens, SECRET_A.slice(0, 10))).toBeNull();
  });
});

describe("loadServeTokens", () => {
  it("prefers REPOSKEIN_SERVE_TOKENS over the committed config.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "reposkein-serve-tokens-"));
    try {
      mkdirSync(join(dir, ".reposkein"), { recursive: true });
      writeFileSync(
        join(dir, ".reposkein", "config.toml"),
        `[serve]\ntokens = "fromconfig:${SECRET_A}"\n`
      );
      const both = loadServeTokens(dir, { REPOSKEIN_SERVE_TOKENS: `fromenv:${SECRET_B}` });
      expect(both.source).toBe("env");
      expect(both.tokens.map((t) => t.name)).toEqual(["fromenv"]);

      const configOnly = loadServeTokens(dir, {});
      expect(configOnly.source).toBe("config");
      expect(configOnly.tokens.map((t) => t.name)).toEqual(["fromconfig"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports source \"none\" when nothing is configured (serve then refuses to start)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reposkein-serve-tokens-"));
    try {
      expect(loadServeTokens(dir, {})).toEqual({ tokens: [], errors: [], source: "none" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
