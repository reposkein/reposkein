import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** A persisted summary record (git-ignored .reposkein/local/summaries.jsonl). */
export interface SidecarSummary {
  id: string;
  semantic_summary: string;
  summary_of_hash: string;
  summary_model: string;
  summary_at: string;
  summary_by: string;
}

export function sidecarPath(repoPath: string): string {
  return join(repoPath, ".reposkein", "local", "summaries.jsonl");
}

/** Reads the sidecar into a map keyed by node id. Missing file → empty map.
 *  Best-effort: malformed lines / read errors are skipped. */
export function readSidecar(path: string): Map<string, SidecarSummary> {
  const map = new Map<string, SidecarSummary>();
  if (!existsSync(path)) return map;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (typeof o.id === "string" && typeof o.semantic_summary === "string") {
        map.set(o.id, {
          id: o.id,
          semantic_summary: o.semantic_summary,
          summary_of_hash: typeof o.summary_of_hash === "string" ? o.summary_of_hash : "",
          summary_model: typeof o.summary_model === "string" ? o.summary_model : "",
          summary_at: typeof o.summary_at === "string" ? o.summary_at : "",
          summary_by: typeof o.summary_by === "string" ? o.summary_by : "",
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return map;
}

/** Upserts one record and rewrites the sidecar sorted by id (deterministic, no
 *  duplicate lines). Creates the local/ dir if needed. Best-effort. */
export function upsertSidecar(path: string, rec: SidecarSummary): void {
  const map = readSidecar(path);
  map.set(rec.id, rec);
  const lines = [...map.keys()].sort().map((id) => {
    const r = map.get(id)!;
    return JSON.stringify({
      id: r.id,
      semantic_summary: r.semantic_summary,
      summary_at: r.summary_at,
      summary_by: r.summary_by,
      summary_model: r.summary_model,
      summary_of_hash: r.summary_of_hash,
    });
  });
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "");
  } catch {
    // best-effort; a write failure must not break the tool call
  }
}
