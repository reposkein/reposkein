import type { GraphStore } from "../store/GraphStore.js";
import type { ResolveResult, TargetRow } from "./types.js";

export interface Selector {
  node_id?: string;
  file_path?: string;
  name?: string;
}

const TARGET_RETURN =
  "t.id AS id, t.name AS name, t.qualified_name AS qualified_name, t.file_path AS file_path, " +
  "t.start_line AS start_line, t.end_line AS end_line, t.semantic_summary AS semantic_summary, " +
  "t.summary_of_hash AS summary_of_hash, t.content_hash AS content_hash, " +
  "[l IN labels(t) WHERE l <> 'Rs'] AS labels";

function toRow(r: Record<string, unknown>): TargetRow {
  return {
    id: r.id as string,
    name: r.name as string,
    qualified_name: (r.qualified_name as string) ?? (r.name as string),
    file_path: (r.file_path as string) ?? "",
    start_line: (r.start_line as number) ?? 0,
    end_line: (r.end_line as number) ?? 0,
    semantic_summary: (r.semantic_summary as string) ?? null,
    summary_of_hash: (r.summary_of_hash as string) ?? null,
    content_hash: (r.content_hash as string) ?? null,
    labels: (r.labels as string[]) ?? [],
  };
}

/** Resolves a target: id → exact path#name → fuzzy name. Returns candidates
 *  (never guesses) when a name matches more than one node (PRD §7.4). */
export async function resolveTarget(
  store: GraphStore,
  repo: string,
  sel: Selector
): Promise<ResolveResult> {
  if (sel.node_id) {
    const rows = await store.runRead(
      `MATCH (t:Rs {id:$id, repo_id:$repo}) RETURN ${TARGET_RETURN}`,
      { id: sel.node_id, repo }
    );
    return rows.length === 1 ? { kind: "found", target: toRow(rows[0]!) } : { kind: "not_found" };
  }
  if (sel.file_path && sel.name) {
    const rows = await store.runRead(
      `MATCH (t:Rs {repo_id:$repo, file_path:$path}) ` +
        `WHERE (t.name = $name OR t.qualified_name = $name) AND (t:Function OR t:Class) ` +
        `RETURN ${TARGET_RETURN}`,
      { repo, path: sel.file_path, name: sel.name }
    );
    if (rows.length === 1) return { kind: "found", target: toRow(rows[0]!) };
    if (rows.length > 1) return { kind: "candidates", candidates: rows.map(toRow) };
    return { kind: "not_found" };
  }
  if (sel.name) {
    const rows = await store.runRead(
      `MATCH (t:Function {repo_id:$repo, name:$name}) RETURN ${TARGET_RETURN}`,
      { repo, name: sel.name }
    );
    if (rows.length === 1) return { kind: "found", target: toRow(rows[0]!) };
    if (rows.length > 1) return { kind: "candidates", candidates: rows.map(toRow) };
    return { kind: "not_found" };
  }
  return { kind: "not_found" };
}
