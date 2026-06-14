import { createWriteStream, existsSync, mkdirSync, chmodSync, statSync, readFileSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Supported platform keys → must match the release asset suffixes (D2). */
const SUPPORTED = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
]);

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

/** Follows redirects (GitHub release assets redirect to a CDN) and streams the
 *  body to `dest`. Rejects on non-2xx (after redirects) or network error. */
function downloadTo(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirects <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        res.resume();
        downloadTo(res.headers.location, dest, redirects - 1).then(resolve, reject);
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

/** Downloads the indexer binary for this host into the package cache and makes
 *  it executable. Throws on unsupported platform or download failure. */
export async function downloadBinary(version: string = packageVersion()): Promise<string> {
  const key = platformKey();
  if (!key) {
    throw new Error(
      `reposkein: no prebuilt indexer for ${process.platform}-${process.arch}; ` +
        `set REPOSKEIN_INDEXER_BIN or build from source.`
    );
  }
  const dest = cachedBinaryPath();
  await downloadTo(releaseUrl(version, key), dest);
  if (!isWindows()) chmodSync(dest, 0o755);
  return dest;
}

/** Resolves the indexer binary for runtime use, in priority order:
 *  1) REPOSKEIN_INDEXER_BIN (dev/tests/override),
 *  2) the cached binary in the package (postinstall),
 *  3) lazily download it,
 *  4) fall back to `reposkein-indexer` on PATH (best effort).
 *  Never throws for case 4 — returns the PATH name so spawn surfaces a clear
 *  ENOENT if it's truly absent. */
export async function ensureIndexerBinary(): Promise<string> {
  const override = process.env.REPOSKEIN_INDEXER_BIN;
  if (override) return override;
  const cached = cachedBinaryPath();
  if (existsSync(cached) && statSync(cached).isFile()) return cached;
  try {
    return await downloadBinary();
  } catch {
    return isWindows() ? "reposkein-indexer.exe" : "reposkein-indexer";
  }
}
