import { describe, it, expect, afterEach } from "vitest";
import {
  platformKey,
  assetName,
  releaseUrl,
  ensureIndexerBinary,
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
