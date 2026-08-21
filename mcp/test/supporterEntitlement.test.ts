import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../src/ads/supporterKey.js", async () => {
  const { mockedSupporterKeyModule } = await import("./supporterTestKey.js");
  return mockedSupporterKeyModule;
});

const { isSupporter, readSupporterStatus, resetSupporterCache, supporterVerdict, RECHECK_INTERVAL_MS } = await import(
  "../src/ads/supporter.js"
);
const { signSupporterToken, SUPPORTER_GRACE_MS } = await import("../src/ads/supporterToken.js");
const { supporterTokenPath } = await import("../src/ads/supporterStore.js");
const { resolveAdsVerdict } = await import("../src/ads/config.js");
const { createAdsHook } = await import("../src/ads/slot.js");
const { TEST_PRIVATE_PEM, testClaims } = await import("./supporterTestKey.js");

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
let tokenFile: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reposkein-supporter-"));
  tokenFile = join(dir, "supporter.jwt");
  env = { REPOSKEIN_SUPPORTER_FILE: tokenFile };
  resetSupporterCache();
});

function mint(overrides: Record<string, unknown> = {}, now = NOW): string {
  return signSupporterToken(testClaims(now, 30, overrides) as never, TEST_PRIVATE_PEM);
}

/** Writes the token and forces a distinct mtime, so a same-millisecond
 *  rewrite in a test cannot be mistaken for an unchanged file. */
function install(token: string, mtimeSeconds = 1_000_000): void {
  writeFileSync(tokenFile, `${token}\n`);
  utimesSync(tokenFile, mtimeSeconds, mtimeSeconds);
}

describe("isSupporter — local entitlement", () => {
  it("is false when there is no entitlement file (every default install)", () => {
    expect(isSupporter(env, NOW)).toBe(false);
    expect(supporterVerdict(env, NOW)).toEqual({ state: "invalid", reason: "empty" });
  });

  it("is true for a valid token", () => {
    install(mint());
    expect(isSupporter(env, NOW)).toBe(true);
  });

  it("is true inside the grace window and false past it", () => {
    const iat = Math.floor(NOW / 1000);
    install(mint({ iat, exp: iat + 10 }));
    const expMs = (iat + 10) * 1000;

    resetSupporterCache();
    expect(isSupporter(env, expMs)).toBe(true);
    resetSupporterCache();
    expect(isSupporter(env, expMs + SUPPORTER_GRACE_MS)).toBe(true);
    resetSupporterCache();
    expect(isSupporter(env, expMs + SUPPORTER_GRACE_MS + 1)).toBe(false);
  });

  it("is false for a forged, truncated, or empty file", () => {
    for (const bad of ["", "  \n", "not-a-token", `rsk1.${Buffer.from("{}").toString("base64url")}.AAAA`]) {
      install(bad, 1_000_001);
      resetSupporterCache();
      expect(isSupporter(env, NOW), `"${bad.slice(0, 12)}" must not entitle`).toBe(false);
    }
  });

  it("is false for a token whose payload was edited to extend it", () => {
    const [, payload, sig] = mint().split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 10 * 365 * 86400 })).toString("base64url");
    install(`rsk1.${forged}.${sig}`);
    expect(isSupporter(env, NOW)).toBe(false);
  });

  it("never throws, whatever is at the path", () => {
    // A directory where a file is expected.
    env = { REPOSKEIN_SUPPORTER_FILE: dir };
    expect(() => isSupporter(env, NOW)).not.toThrow();
    expect(isSupporter(env, NOW)).toBe(false);
  });
});

describe("isSupporter — caching and the mtime recheck", () => {
  it("re-evaluates expiry on every call without touching the file", () => {
    const iat = Math.floor(NOW / 1000);
    install(mint({ iat, exp: iat + 60 }));
    expect(isSupporter(env, NOW)).toBe(true);
    // Same cache entry, far past grace: the clock alone flips the answer.
    expect(isSupporter(env, NOW + 60_000 + SUPPORTER_GRACE_MS + 1)).toBe(false);
  });

  it("picks up a newly installed token within the recheck interval", () => {
    expect(isSupporter(env, NOW)).toBe(false);
    install(mint());
    // Inside the throttle window the cached "no file" answer still stands...
    expect(isSupporter(env, NOW + RECHECK_INTERVAL_MS - 1)).toBe(false);
    // ...and the next probe after it sees the file.
    expect(isSupporter(env, NOW + RECHECK_INTERVAL_MS)).toBe(true);
  });

  it("notices the token being replaced with a different one", () => {
    install(mint(), 1_000_000);
    expect(isSupporter(env, NOW)).toBe(true);
    const iat = Math.floor(NOW / 1000);
    install(mint({ iat, exp: iat + 1 }), 1_000_500);
    expect(isSupporter(env, NOW + RECHECK_INTERVAL_MS + SUPPORTER_GRACE_MS + 2000)).toBe(false);
  });

  it("notices the token being deleted", () => {
    install(mint());
    expect(isSupporter(env, NOW)).toBe(true);
    rmSync(tokenFile);
    expect(isSupporter(env, NOW + RECHECK_INTERVAL_MS)).toBe(false);
  });

  it("does not stat the file on every call", () => {
    install(mint());
    expect(isSupporter(env, NOW)).toBe(true);
    // Delete it, then ask again inside the window. A per-call stat would
    // report false; the throttle is what makes this true.
    rmSync(tokenFile);
    expect(isSupporter(env, NOW + 1)).toBe(true);
  });
});

describe("readSupporterStatus — the uncached CLI view", () => {
  it("reports none / valid / grace / expired / invalid distinctly", () => {
    expect(readSupporterStatus(env, NOW).state).toBe("none");

    const iat = Math.floor(NOW / 1000);
    install(mint({ iat, exp: iat + 100 }));
    const expMs = (iat + 100) * 1000;
    expect(readSupporterStatus(env, NOW).state).toBe("valid");
    expect(readSupporterStatus(env, expMs + 1).state).toBe("grace");
    expect(readSupporterStatus(env, expMs + SUPPORTER_GRACE_MS + 1).state).toBe("expired");

    install("garbage", 1_000_002);
    const bad = readSupporterStatus(env, NOW);
    expect(bad.state).toBe("invalid");
    if (bad.state === "invalid") expect(bad.reason).toBe("malformed");
  });

  it("reports the path it looked at, even when nothing is there", () => {
    expect(readSupporterStatus(env, NOW).path).toBe(tokenFile);
  });

  it("defaults to ~/.config/reposkein/supporter.jwt", () => {
    const path = supporterTokenPath({ HOME: "/home/example" });
    expect(path.endsWith(join(".config", "reposkein", "supporter.jwt"))).toBe(true);
    expect(path).not.toContain(".reposkein");
  });

  it("honours XDG_CONFIG_HOME when it is absolute", () => {
    expect(supporterTokenPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "reposkein", "supporter.jwt"));
    // A relative XDG_CONFIG_HOME is ignored rather than resolved against cwd,
    // which would make the entitlement location depend on where you stood.
    expect(supporterTokenPath({ XDG_CONFIG_HOME: "relative/path" })).not.toContain("relative");
  });
});

describe("the gating chain consults the supporter gate before requesting a slot", () => {
  const CREDS = { LULU_ADS_PUBLISHER_ID: "pub_test", LULU_ADS_API_KEY: "lk_test" };

  it("reports `supporter` as the reason, not `enabled`", () => {
    install(mint());
    const verdict = resolveAdsVerdict({
      env: { REPOSKEIN_ADS: "on", ...CREDS },
      isSupporter: () => isSupporter(env, NOW),
    });
    expect(verdict).toEqual({ enabled: false, reason: "supporter" });
  });

  it("makes ZERO slot requests for a supporter, on an otherwise fully enabled install", async () => {
    // `createAdsHook` reads the real clock (that is the production path), so
    // this token is minted relative to it rather than to the fixed NOW the
    // rest of the file uses.
    install(mint({}, Date.now()));
    const requestSlot = vi.fn(async () => ({ text: "buy things", url: "https://ads.getlulu.dev/c/x" }));
    const audit = vi.fn();
    const hook = createAdsHook({
      resolveRepoPath: () => dir,
      env: { REPOSKEIN_ADS: "on", ...CREDS, REPOSKEIN_SUPPORTER_FILE: tokenFile },
      source: { requestSlot },
      readOptIn: () => true,
      audit,
      schedule: (fn) => fn(),
    });
    const inner = async () => ({ content: [{ type: "text", text: "answer" }] });
    const wrapped = hook.withAds("get_context_profile", inner);
    const result = await wrapped({});

    expect(requestSlot).not.toHaveBeenCalled();
    // Not even the local audit line: no request left the machine to record.
    expect(audit).not.toHaveBeenCalled();
    expect(result).toEqual({ content: [{ type: "text", text: "answer" }] });
    expect(result._meta).toBeUndefined();
  });

  it("still requests a slot when the token is expired past grace", async () => {
    // Issued 100 days ago, expired 90 days ago — well outside grace against
    // the real clock this code path uses.
    const past = Math.floor((Date.now() - 100 * DAY_MS) / 1000);
    install(mint({ iat: past, exp: past + 10 * 86400 }));
    resetSupporterCache();
    const requestSlot = vi.fn(async () => null);
    const hook = createAdsHook({
      resolveRepoPath: () => dir,
      env: { REPOSKEIN_ADS: "on", ...CREDS, REPOSKEIN_SUPPORTER_FILE: tokenFile },
      source: { requestSlot },
      readOptIn: () => true,
      audit: () => {},
      schedule: (fn) => fn(),
    });
    await hook.withAds("get_context_profile", async () => ({ content: [] }))({});
    expect(requestSlot).toHaveBeenCalledTimes(1);
  });
});

describe("verification is provably offline", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = resolve(here, "..", "src");

  /** Every module specifier a source file pulls in, by ANY syntax that can
   *  bring code into the process:
   *
   *   - `import x from "s"` / `import {x} from "s"` / `import * as x from "s"`
   *   - `import "s"`            — side-effect only, no bindings, easy to miss
   *   - `export {x} from "s"`   — a re-export executes the module too
   *   - `export * from "s"`
   *   - `import("s")`           — dynamic
   *   - `require("s")`          — CJS interop
   *
   *  The first version of this walker matched only the `… from "s"` shape,
   *  which meant a single `import "./phone-home.js"` would have slipped
   *  through the very test whose job is to prove nothing here can reach the
   *  network. The walker self-test below pins all of them. */
  function specifiersOf(source: string): string[] {
    const patterns = [
      /(?:^|[\s;}])import\s[^;'"]*?from\s*["']([^"']+)["']/g,
      /(?:^|[\s;}])import\s*["']([^"']+)["']/g,
      /(?:^|[\s;}])export\s[^;'"]*?from\s*["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    const out: string[] = [];
    for (const p of patterns) for (const m of source.matchAll(p)) out.push(m[1]!);
    return out;
  }

  /** Walks the static import graph from `ads/supporter.ts`. `read` is a seam
   *  so the walker can be run over synthetic sources — without it, "the graph
   *  is clean" and "the walker sees nothing" are indistinguishable. */
  function importGraph(
    entry: string,
    read: (f: string) => string = (f) => readFileSync(f, "utf8")
  ): Map<string, string> {
    const seen = new Map<string, string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      const source = read(file);
      seen.set(file, source);
      for (const spec of specifiersOf(source)) {
        if (!spec.startsWith(".")) continue;
        queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
    return seen;
  }

  const graph = importGraph(join(srcRoot, "ads", "supporter.ts"));
  const rel = (f: string) => f.slice(srcRoot.length + 1).replace(/\\/g, "/");

  describe("walker self-test — the detector is not vacuous", () => {
    /** Runs the walker over an in-memory module tree. */
    function walkFake(files: Record<string, string>): string[] {
      const root = "/fake";
      const read = (f: string) => {
        const key = f.slice(root.length + 1);
        if (!(key in files)) throw new Error(`unexpected read of ${key}`);
        return files[key]!;
      };
      return [...importGraph(`${root}/entry.ts`, read).keys()].map((f) => f.slice(root.length + 1)).sort();
    }

    it("follows a plain `from` import", () => {
      expect(walkFake({ "entry.ts": `import { a } from "./a.js";`, "a.ts": "" })).toEqual(["a.ts", "entry.ts"]);
    });

    it("follows a SIDE-EFFECT import with no bindings", () => {
      expect(walkFake({ "entry.ts": `import "./a.js";`, "a.ts": "" })).toEqual(["a.ts", "entry.ts"]);
    });

    it("follows a re-export", () => {
      expect(walkFake({ "entry.ts": `export { a } from "./a.js";`, "a.ts": "" })).toEqual(["a.ts", "entry.ts"]);
    });

    it("follows `export * from`", () => {
      expect(walkFake({ "entry.ts": `export * from "./a.js";`, "a.ts": "" })).toEqual(["a.ts", "entry.ts"]);
    });

    it("follows a dynamic import and a require", () => {
      expect(walkFake({ "entry.ts": `const a = await import("./a.js");`, "a.ts": "" })).toEqual(["a.ts", "entry.ts"]);
      expect(walkFake({ "entry.ts": `const a = require("./a.js");`, "a.ts": "" })).toEqual(["a.ts", "entry.ts"]);
    });

    it("follows transitively, so a leaf cannot hide behind a clean parent", () => {
      expect(walkFake({ "entry.ts": `import "./a.js";`, "a.ts": `import "./b.js";`, "b.ts": "" })).toEqual([
        "a.ts",
        "b.ts",
        "entry.ts",
      ]);
    });

    it("sees bare specifiers pulled in by every syntax", () => {
      expect(specifiersOf(`import "undici";`)).toContain("undici");
      expect(specifiersOf(`export * from "node:http";`)).toContain("node:http");
      expect(specifiersOf(`const { get } = require("node:https");`)).toContain("node:https");
      expect(specifiersOf(`await import("node:net");`)).toContain("node:net");
    });
  });

  it("reaches only the four entitlement modules", () => {
    expect([...graph.keys()].map(rel).sort()).toEqual([
      "ads/supporter.ts",
      "ads/supporterKey.ts",
      "ads/supporterStore.ts",
      "ads/supporterToken.ts",
    ]);
  });

  it("imports no networking module, builtin or otherwise", () => {
    const allowedBuiltins = new Set(["node:crypto", "node:fs", "node:os", "node:path"]);
    for (const [file, source] of graph) {
      for (const spec of specifiersOf(source)) {
        if (spec.startsWith(".")) continue;
        expect(allowedBuiltins.has(spec), `${rel(file)} imports ${spec}`).toBe(true);
      }
    }
  });

  it("contains no call that could open a connection", () => {
    // Comments are stripped first so prose about *not* making network calls
    // cannot fail (or accidentally satisfy) the check.
    const forbidden = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /\bnode:(?:http|https|net|tls|dgram|dns)\b/,
      /\bundici\b/,
      /\bnavigator\.sendBeacon\b/,
      /\bhttps?:\/\//,
      // `require(` at all, not merely of a networking module: a runtime
      // require is a way to reach code the static walk above never sees.
      /\brequire\s*\(/,
      /\bcreateRequire\b/,
      /\bprocess\.binding\b/,
    ];
    for (const [file, source] of graph) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const pattern of forbidden) {
        expect(pattern.test(code), `${rel(file)} matches ${pattern}`).toBe(false);
      }
    }
  });

  it("verifies with the network primitives removed entirely", async () => {
    install(mint());
    resetSupporterCache();
    const explode = () => {
      throw new Error("the entitlement path must not touch the network");
    };
    vi.stubGlobal("fetch", explode);
    try {
      expect(isSupporter(env, NOW)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("entitlement never lands in a repository", () => {
  it("writes nothing under the repo, only under the user config path", () => {
    const repo = mkdtempSync(join(tmpdir(), "reposkein-repo-"));
    writeFileSync(join(repo, "marker.txt"), "unchanged");
    const before = snapshot(repo);

    install(mint({}, Date.now()));
    expect(isSupporter(env)).toBe(true);

    expect(snapshot(repo)).toEqual(before);
    expect(existsSync(join(repo, ".reposkein"))).toBe(false);
    expect(statSync(tokenFile).isFile()).toBe(true);
  });
});

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else out[rel] = readFileSync(full, "utf8");
    }
  };
  walk(root, "");
  return out;
}
