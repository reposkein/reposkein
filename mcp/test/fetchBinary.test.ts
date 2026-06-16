import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import {
  platformKey,
  assetName,
  releaseUrl,
  ensureIndexerBinary,
  expectedDigest,
  IntegrityError,
  verifyDigest,
  packageRoot,
  _resetDigestCache,
} from "../src/indexer/fetchBinary.js";

describe("fetchBinary mapping", () => {
  it("maps supported platforms", () => {
    expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformKey("linux", "x64")).toBe("linux-x64");
    expect(platformKey("win32", "x64")).toBe("win32-x64");
  });
  it("returns null for unsupported platforms", () => {
    expect(platformKey("linux", "ppc64")).toBeNull();
    expect(platformKey("freebsd", "x64")).toBeNull();
    // Intel macOS is intentionally unsupported (Apple Silicon only).
    expect(platformKey("darwin", "x64")).toBeNull();
  });
  it("asset name adds .exe only for windows", () => {
    expect(assetName("darwin-arm64")).toBe("reposkein-indexer-darwin-arm64");
    expect(assetName("win32-x64")).toBe("reposkein-indexer-win32-x64.exe");
  });
  it("builds the GitHub release URL for the version", () => {
    expect(releaseUrl("1.2.3", "linux-x64")).toBe(
      "https://github.com/reposkein/reposkein/releases/download/v1.2.3/reposkein-indexer-linux-x64"
    );
  });
});

describe("ensureIndexerBinary resolution", () => {
  const saved = process.env.REPOSKEIN_INDEXER_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.REPOSKEIN_INDEXER_BIN;
    else process.env.REPOSKEIN_INDEXER_BIN = saved;
  });
  it("honors REPOSKEIN_INDEXER_BIN first (no fetch)", async () => {
    process.env.REPOSKEIN_INDEXER_BIN = "/custom/reposkein-indexer";
    expect(await ensureIndexerBinary()).toBe("/custom/reposkein-indexer");
  });
});

describe("verifyDigest", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), "reposkein-test-" + randomBytes(4).toString("hex"));
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* already deleted */ }
  });

  it("passes when sha256 matches", () => {
    const content = Buffer.from("hello reposkein");
    writeFileSync(tmpFile, content);
    const hash = createHash("sha256").update(content).digest("hex");
    expect(() => verifyDigest(tmpFile, hash)).not.toThrow();
    expect(existsSync(tmpFile)).toBe(true);
  });

  it("throws IntegrityError and removes temp file when sha256 mismatches", () => {
    const content = Buffer.from("hello reposkein");
    writeFileSync(tmpFile, content);
    expect(() => verifyDigest(tmpFile, "deadbeef".repeat(8))).toThrow(IntegrityError);
    // file must be deleted on mismatch
    expect(existsSync(tmpFile)).toBe(false);
  });

  it("warns to stderr and passes (does not throw) when expected is null (dev build)", () => {
    const content = Buffer.from("no digest check — dev build");
    writeFileSync(tmpFile, content);
    expect(() => verifyDigest(tmpFile, null)).not.toThrow();
    expect(existsSync(tmpFile)).toBe(true);
  });
});

describe("expectedDigest", () => {
  const digestPath = join(packageRoot(), "binary-digests.json");

  afterEach(() => {
    // Always reset the cache and remove any test digest file we wrote
    _resetDigestCache();
    try { unlinkSync(digestPath); } catch { /* may not exist */ }
  });

  it("returns null when binary-digests.json is absent", () => {
    // Ensure no digest file exists
    try { unlinkSync(digestPath); } catch { /* ok */ }
    _resetDigestCache();
    expect(expectedDigest("darwin-arm64")).toBeNull();
  });

  it("throws IntegrityError when file is present but key is missing", () => {
    // Write a digest file that has linux-x64 but not darwin-arm64
    writeFileSync(digestPath, JSON.stringify({
      "reposkein-indexer-linux-x64": "a".repeat(64),
    }));
    _resetDigestCache();
    expect(() => expectedDigest("darwin-arm64")).toThrow(IntegrityError);
  });

  it("returns the digest when file is present and key exists", () => {
    const fakeDigest = "b".repeat(64);
    writeFileSync(digestPath, JSON.stringify({
      "reposkein-indexer-darwin-arm64": fakeDigest,
    }));
    _resetDigestCache();
    expect(expectedDigest("darwin-arm64")).toBe(fakeDigest);
  });
});
