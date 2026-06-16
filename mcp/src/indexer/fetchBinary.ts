import { createWriteStream, existsSync, mkdirSync, chmodSync, statSync, readFileSync, unlinkSync, renameSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Supported platform keys → must match the release asset suffixes (D2).
 *  Intel macOS (darwin-x64) is intentionally unsupported: all Macs have shipped
 *  Apple Silicon since 2020, and GitHub's macos-13 Intel runners are scarce and
 *  deprecated. darwin-x64 hosts fall through to PATH resolution (or a clear error). */
const SUPPORTED = new Set([
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
]);

/** Custom error class for integrity check failures. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** `<platform>-<arch>` for the current host, or null if unsupported. */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch
): string | null {
  const key = `${platform}-${arch}`;
  return SUPPORTED.has(key) ? key : null;
}

export function isWindows(platform: string = process.platform): boolean {
  return platform === "win32";
}

/** Release asset name for a platform key, e.g. reposkein-indexer-darwin-arm64. */
export function assetName(key: string): string {
  return `reposkein-indexer-${key}${key.startsWith("win32") ? ".exe" : ""}`;
}

/** GitHub Release download URL for the given version + platform key. */
export function releaseUrl(version: string, key: string): string {
  return `https://github.com/reposkein/reposkein/releases/download/v${version}/${assetName(key)}`;
}

/** Package root (two levels up from dist/indexer/fetchBinary.js). */
export function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Cached binary path inside the package's bin/ dir. */
export function cachedBinaryPath(): string {
  return join(packageRoot(), "bin", isWindows() ? "reposkein-indexer.exe" : "reposkein-indexer");
}

/** Reads this package's version (the release tag to fetch). */
export function packageVersion(): string {
  // dist/indexer/fetchBinary.js → package.json is two levels up.
  const pkgPath = join(packageRoot(), "package.json");
  const txt = readFileSync(pkgPath, "utf8");
  return JSON.parse(txt).version as string;
}

/** Module-level digest map cache. `undefined` = not yet loaded, `null` = file absent. */
let _digestMap: Record<string, string> | null | undefined = undefined;

function loadDigestMap(): Record<string, string> | null {
  if (_digestMap !== undefined) return _digestMap;
  const p = join(packageRoot(), "binary-digests.json");
  if (!existsSync(p)) { _digestMap = null; return null; }
  _digestMap = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  return _digestMap;
}

/** Returns the expected sha256 hex digest for the given platform key's asset,
 *  or null if binary-digests.json doesn't exist (dev/source build).
 *  Throws IntegrityError if the file exists but has no entry for this platform. */
export function expectedDigest(key: string): string | null {
  const map = loadDigestMap();
  if (map === null) return null; // dev/source build — no digests file
  const name = assetName(key);
  if (!(name in map)) throw new IntegrityError(`reposkein: binary-digests.json is present but has no entry for ${name} — refusing to run`);
  return map[name] ?? null;
}

/** For testing only: reset the cached digest map so the next call re-reads from disk. */
export function _resetDigestCache(): void {
  _digestMap = undefined;
}

/** Verifies the sha256 digest of the file at `tempPath`.
 *  If `expected` is non-null and doesn't match, deletes the temp file and throws IntegrityError.
 *  If `expected` is null (dev/source build), writes a warning to stderr and returns. */
export function verifyDigest(tempPath: string, expected: string | null): void {
  if (expected === null) {
    process.stderr.write("reposkein: no binary-digests.json found — skipping integrity check (dev/source build)\n");
    return;
  }
  const actual = createHash("sha256").update(readFileSync(tempPath)).digest("hex");
  if (actual !== expected) {
    unlinkSync(tempPath);
    throw new IntegrityError("reposkein: indexer binary failed integrity check (sha256 mismatch) — refusing to run");
  }
}

/** Follows redirects (GitHub release assets redirect to a CDN) and streams the
 *  body to `dest`. Rejects on non-2xx (after redirects) or network error.
 *  Redirect hardening: only follows https:// redirects to github.com or *.githubusercontent.com. */
function downloadTo(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirects <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        const location = res.headers.location;
        const next = new URL(location, url);
        if (next.protocol !== "https:") {
          reject(new Error(`reposkein: redirect to non-https URL rejected: ${next.href}`));
          return;
        }
        const host = next.hostname;
        if (
          host !== "github.com" &&
          host !== "objects.githubusercontent.com" &&
          !host.endsWith(".githubusercontent.com")
        ) {
          reject(new Error(`reposkein: redirect to non-allowlisted host rejected: ${host}`));
          return;
        }
        res.resume();
        downloadTo(next.href, dest, redirects - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${status} for ${url}`));
        return;
      }
      mkdirSync(dirname(dest), { recursive: true });
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

/** Downloads the indexer binary for this host into the package cache, verifies
 *  its integrity, makes it executable, and atomically renames it into place.
 *  Throws IntegrityError on digest mismatch. Throws on unsupported platform or
 *  download failure. */
export async function downloadBinary(version: string = packageVersion()): Promise<string> {
  const key = platformKey();
  if (!key) {
    throw new Error(
      `reposkein: no prebuilt indexer for ${process.platform}-${process.arch}; ` +
        `set REPOSKEIN_INDEXER_BIN or build from source.`
    );
  }
  const temp = cachedBinaryPath() + ".tmp-" + process.pid + "-" + randomBytes(4).toString("hex");
  try {
    await downloadTo(releaseUrl(version, key), temp);
    verifyDigest(temp, expectedDigest(key));
    if (!isWindows()) chmodSync(temp, 0o755);
    renameSync(temp, cachedBinaryPath());
  } catch (err) {
    try { unlinkSync(temp); } catch { /* already deleted (e.g. by verifyDigest on mismatch) or never created */ }
    throw err;
  }
  return cachedBinaryPath();
}

/** Resolves the indexer binary for runtime use, in priority order:
 *  1) REPOSKEIN_INDEXER_BIN (dev/tests/override),
 *  2) the cached binary in the package (postinstall),
 *  3) lazily download it,
 *  4) fall back to `reposkein-indexer` on PATH (best effort).
 *  Never throws for case 4 — returns the PATH name so spawn surfaces a clear
 *  ENOENT if it's truly absent.
 *  Always re-throws IntegrityError — never falls back to PATH on integrity failure. */
export async function ensureIndexerBinary(): Promise<string> {
  const override = process.env.REPOSKEIN_INDEXER_BIN;
  if (override) return override;
  const cached = cachedBinaryPath();
  if (existsSync(cached) && statSync(cached).isFile()) return cached;
  try {
    return await downloadBinary();
  } catch (err) {
    if (err instanceof IntegrityError) throw err; // integrity mismatch: hard fail, never fall back
    return isWindows() ? "reposkein-indexer.exe" : "reposkein-indexer";
  }
}
