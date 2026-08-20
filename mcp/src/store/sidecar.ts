import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** A persisted summary record (git-ignored .reposkein/local/summaries-<agent>.jsonl). */
export interface SidecarSummary {
  id: string;
  semantic_summary: string;
  summary_of_hash: string;
  summary_model: string;
  summary_at: string;
  summary_by: string;
}

/** Directory holding every agent's sidecar. Git-ignored in full. */
export function sidecarDir(repoPath: string): string {
  return join(repoPath, ".reposkein", "local");
}

/** Filesystem-safe slug for the writing agent.
 *
 *  Untrusted input: REPOSKEIN_AGENT comes from whatever launched the server, so
 *  it is reduced to `[a-z0-9._-]` and capped. A value that reduces to nothing
 *  (or is absent) falls back to "agent", which is also the pre-multi-agent
 *  name — so a single-agent setup keeps one stable file. */
export function agentSlug(agent = process.env.REPOSKEIN_AGENT): string {
  const slug = (agent ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40)
    .replace(/[-.]+$/, "");
  return slug === "" ? "agent" : slug;
}

/** THIS process's sidecar: one file per agent.
 *
 *  A single shared `local/summaries.jsonl` meant two agents running against the
 *  same checkout silently overwrote each other — `upsertSidecar` rewrites the
 *  whole file, so the slower writer's prose vanished with no error anywhere.
 *  One file per writer removes the shared mutable state; the indexer folds
 *  every `local/summaries*.jsonl` into the committed shards. */
export function sidecarPath(repoPath: string, agent?: string): string {
  return join(sidecarDir(repoPath), `summaries-${agentSlug(agent)}.jsonl`);
}

/** Every agent's sidecar in this repo, sorted, so reads are deterministic and
 *  independent of directory order. Includes the pre-split
 *  `local/summaries.jsonl` an older client may still be writing. */
export function sidecarPaths(repoPath: string): string[] {
  const dir = sidecarDir(repoPath);
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith("summaries") && f.endsWith(".jsonl"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
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

/** Every agent's sidecar records, merged. Later files win on a collision, and
 *  file order is sorted, so the result does not depend on directory order. */
export function readAllSidecars(repoPath: string): Map<string, SidecarSummary> {
  const merged = new Map<string, SidecarSummary>();
  for (const p of sidecarPaths(repoPath)) {
    for (const [id, rec] of readSidecar(p)) merged.set(id, rec);
  }
  return merged;
}

/** Upserts one record and rewrites the sidecar sorted by id (deterministic, no
 *  duplicate lines). Creates the local/ dir if needed. Best-effort.
 *
 *  Rewriting the whole file is safe only because `path` belongs to one agent:
 *  see `sidecarPath`. */
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
