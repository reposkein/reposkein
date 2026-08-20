import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SourceSliceEntry {
  path: string;
  start: number;
  end: number;
  lines: string[];
}

export interface CollectSourceSlicesDeps {
  /** Reads a file's text given its absolute path. Injected for testability. */
  readFile?: (absPath: string) => string;
}

/** Reads `nodesText` (JSONL) and, for every node carrying a file_path/path plus
 *  start_line/end_line, slices that range out of the source file — keyed by
 *  node id. Stops as soon as the running byte total would exceed `maxBytes`
 *  (deterministic: first-in-file-order nodes win, so a fixed input always
 *  bakes the same slice set). Best-effort per-file: a file that can't be read
 *  is skipped, not fatal. Pure aside from the injected `readFile`. */
export function collectSourceSlices(
  repoPath: string,
  nodesText: string,
  maxBytes: number,
  deps: CollectSourceSlicesDeps = {},
): Record<string, SourceSliceEntry> {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const out: Record<string, SourceSliceEntry> = {};
  const fileCache = new Map<string, string[] | null>();
  let used = 0;

  for (const line of nodesText.split("\n")) {
    if (!line.trim()) continue;
    let node: { id?: unknown; props?: Record<string, unknown> };
    try {
      node = JSON.parse(line) as { id?: unknown; props?: Record<string, unknown> };
    } catch {
      continue;
    }
    const id = node.id;
    const props = node.props ?? {};
    const filePath = props["file_path"] ?? props["path"];
    const start = props["start_line"];
    const end = props["end_line"];
    if (
      typeof id !== "string" ||
      typeof filePath !== "string" ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      end < start ||
      start < 1
    ) {
      continue;
    }

    let fileLines = fileCache.get(filePath);
    if (fileLines === undefined) {
      try {
        fileLines = readFile(join(repoPath, filePath)).split("\n");
      } catch {
        fileLines = null;
      }
      fileCache.set(filePath, fileLines);
    }
    if (fileLines === null) continue;

    const lines = fileLines.slice(start - 1, end);
    const entry: SourceSliceEntry = { path: filePath, start, end, lines };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (used + size > maxBytes) break; // deterministic cap: stop at the first node that overflows
    used += size;
    out[id] = entry;
  }

  return out;
}
