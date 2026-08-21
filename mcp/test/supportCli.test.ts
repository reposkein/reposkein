import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("../src/ads/supporterKey.js", async () => {
  const { mockedSupporterKeyModule } = await import("./supporterTestKey.js");
  return mockedSupporterKeyModule;
});

const { parseSupportArgs, runSupport } = await import("../src/cli/support.js");
const { signSupporterToken } = await import("../src/ads/supporterToken.js");
const { resetSupporterCache } = await import("../src/ads/supporter.js");
const { TEST_PRIVATE_PEM, testClaims } = await import("./supporterTestKey.js");

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const DAY = 24 * 60 * 60;

let dir: string;
let tokenFile: string;
let env: NodeJS.ProcessEnv;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-support-cli-"));
  tokenFile = join(dir, "cfg", "reposkein", "supporter.jwt");
  env = { REPOSKEIN_SUPPORTER_FILE: tokenFile, NO_COLOR: "1" };
  out = [];
  err = [];
  resetSupporterCache();
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mint(overrides: Record<string, unknown> = {}): string {
  return signSupporterToken(testClaims(NOW, 30, overrides) as never, TEST_PRIVATE_PEM);
}

const stdout = () => out.join("\n");
const stderr = () => err.join("\n");

describe("parseSupportArgs", () => {
  it("defaults to --status", () => {
    expect(parseSupportArgs([])).toEqual({ mode: "status", json: false });
  });

  it("reads a bare token as an install", () => {
    expect(parseSupportArgs(["rsk1.a.b"])).toEqual({ mode: "install", json: false, token: "rsk1.a.b" });
  });

  it("accepts --status, --remove and --json", () => {
    expect(parseSupportArgs(["--status", "--json"])).toEqual({ mode: "status", json: true });
    expect(parseSupportArgs(["--remove"]).mode).toBe("remove");
  });

  it("refuses two modes at once", () => {
    expect(parseSupportArgs(["--status", "--remove"]).error).toMatch(/only one/);
    expect(parseSupportArgs(["rsk1.a.b", "--remove"]).error).toMatch(/only one/);
  });

  it("refuses an unknown flag rather than guessing", () => {
    expect(parseSupportArgs(["--activate"]).error).toMatch(/unknown flag/);
  });
});

describe("reposkein-mcp support <token>", () => {
  it("verifies, stores, and reports tier and expiry", () => {
    const code = runSupport([mint()], env, NOW);
    expect(code).toBe(0);
    expect(existsSync(tokenFile)).toBe(true);
    expect(readFileSync(tokenFile, "utf8").trim()).toBe(mint());
    expect(stdout()).toMatch(/installed/i);
    expect(stdout()).toMatch(/tier skein/);
    expect(stdout()).toMatch(/expires 2026-09-20/);
    expect(stdout()).toMatch(/30 days from now/);
  });

  it("stores the token with mode 600 and the directory 700", () => {
    runSupport([mint()], env, NOW);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cfg", "reposkein")).mode & 0o777).toBe(0o700);
  });

  it("re-tightens permissions when overwriting a world-readable token", () => {
    runSupport([mint()], env, NOW);
    chmodSync(tokenFile, 0o644);
    // `writeFileSync`'s mode option only applies on creation; an explicit
    // chmod after the write is what makes this pass.
    runSupport([mint({ sub: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" })], env, NOW);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it("refuses a tampered token and writes nothing", () => {
    const [, payload, sig] = mint().split(".") as [string, string, string];
    const forged = `rsk1.${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${sig}`;
    expect(runSupport([forged], env, NOW)).toBe(1);
    expect(existsSync(tokenFile)).toBe(false);
    expect(stderr()).toMatch(/refusing to install/);
  });

  it("refuses gibberish with an explanation, not just 'invalid'", () => {
    expect(runSupport(["hello"], env, NOW)).toBe(1);
    expect(stderr()).toMatch(/rsk1\.<payload>\.<signature>/);
    expect(stderr()).toMatch(/ko-fi\.com/);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("refuses a token that is already dead past its grace period", () => {
    const iat = Math.floor(NOW / 1000) - 100 * DAY;
    expect(runSupport([mint({ iat, exp: iat + 10 * DAY })], env, NOW)).toBe(1);
    expect(stderr()).toMatch(/expired on 2026-05-23/);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("accepts a token that is inside its grace period", () => {
    const iat = Math.floor(NOW / 1000) - 40 * DAY;
    expect(runSupport([mint({ iat, exp: iat + 39 * DAY })], env, NOW)).toBe(0);
    expect(stdout()).toMatch(/grace period/);
    expect(existsSync(tokenFile)).toBe(true);
  });

  it("never echoes the whole token back", () => {
    const token = mint();
    runSupport([token], env, NOW);
    expect(stdout()).not.toContain(token);
  });
});

describe("reposkein-mcp support --status", () => {
  it("reports 'none installed' plus where to get one, and exits 1", () => {
    expect(runSupport(["--status"], env, NOW)).toBe(1);
    expect(stdout()).toMatch(/none installed/);
    expect(stdout()).toContain(tokenFile);
    expect(stdout()).toMatch(/ko-fi\.com/);
  });

  it("reports an active entitlement and exits 0", () => {
    runSupport([mint()], env, NOW);
    out = [];
    expect(runSupport(["--status"], env, NOW)).toBe(0);
    expect(stdout()).toMatch(/active/);
    expect(stdout()).toMatch(/Sponsored slots are suppressed/);
    // The opaque subject is shown only as a prefix, and labelled as opaque.
    expect(stdout()).toMatch(/subject AAAABBBB…/);
    expect(stdout()).toMatch(/not an account, not an email/);
  });

  it("reports the grace period with days remaining", () => {
    const iat = Math.floor(NOW / 1000) - 31 * DAY;
    runSupport([mint({ iat, exp: iat + 30 * DAY })], env, NOW);
    out = [];
    expect(runSupport(["--status"], env, NOW)).toBe(0);
    expect(stdout()).toMatch(/in grace period/);
    expect(stdout()).toMatch(/2 more days/);
  });

  it("reports a lapsed entitlement and exits 1", () => {
    const iat = Math.floor(NOW / 1000);
    runSupport([mint({ iat, exp: iat + 60 })], env, NOW);
    out = [];
    const later = NOW + 60_000 + 4 * DAY * 1000;
    expect(runSupport(["--status"], env, later)).toBe(1);
    expect(stdout()).toMatch(/expired/);
    expect(stdout()).toMatch(/grace period has also passed/);
    expect(stdout()).toMatch(/ko-fi\.com/);
  });

  it("explains a corrupted token file and points at --remove", () => {
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, "rsk1.not-a-real-token");
    expect(runSupport(["--status"], env, NOW)).toBe(1);
    expect(stdout()).toMatch(/invalid token/);
    expect(stdout()).toMatch(/support --remove/);
  });

  it("warns when the token file is readable by others", () => {
    runSupport([mint()], env, NOW);
    chmodSync(tokenFile, 0o644);
    out = [];
    runSupport(["--status"], env, NOW);
    expect(stdout()).toMatch(/mode 644 — readable by others/);
  });

  it("emits machine-readable JSON on request", () => {
    runSupport([mint()], env, NOW);
    out = [];
    runSupport(["--status", "--json"], env, NOW);
    const parsed = JSON.parse(stdout());
    expect(parsed).toMatchObject({
      state: "valid",
      tier: "skein",
      entitled: true,
      path: tokenFile,
      expiresAt: "2026-09-20T12:00:00.000Z",
      graceEndsAt: "2026-09-23T12:00:00.000Z",
    });
    expect(parsed.kofi).toMatch(/ko-fi\.com/);
  });

  it("reports entitled:false in JSON when nothing is installed", () => {
    runSupport(["--status", "--json"], env, NOW);
    expect(JSON.parse(stdout())).toMatchObject({ state: "none", entitled: false });
  });
});

describe("reposkein-mcp support --remove", () => {
  it("deletes the token and says so", () => {
    runSupport([mint()], env, NOW);
    out = [];
    expect(runSupport(["--remove"], env, NOW)).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
    expect(stdout()).toMatch(/Removed supporter token/);
  });

  it("is a no-op, not an error, when there is nothing to remove", () => {
    expect(runSupport(["--remove"], env, NOW)).toBe(0);
    expect(stdout()).toMatch(/No supporter token to remove/);
  });

  it("leaves --status reporting none afterwards", () => {
    runSupport([mint()], env, NOW);
    runSupport(["--remove"], env, NOW);
    out = [];
    expect(runSupport(["--status"], env, NOW)).toBe(1);
    expect(stdout()).toMatch(/none installed/);
  });
});

describe("the CLI never writes inside a repository", () => {
  it("touches nothing under the working repo for install, status, or remove", () => {
    const repo = mkdtempSync(join(tmpdir(), "reposkein-cli-repo-"));
    writeFileSync(join(repo, "file.txt"), "content");
    const before = snapshot(repo);
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      runSupport([mint()], env, NOW);
      runSupport(["--status"], env, NOW);
      runSupport(["--remove"], env, NOW);
    } finally {
      process.chdir(cwd);
    }
    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(join(repo, ".reposkein"))).toBe(false);
    expect(existsSync(join(repo, "supporter.jwt"))).toBe(false);
  });
});

function snapshot(root: string): Record<string, string> {
  const acc: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else acc[rel] = readFileSync(full, "utf8");
    }
  };
  walk(root, "");
  return acc;
}
