import type { GraphStore } from "../store/GraphStore.js";
import { summaryState } from "./summary.js";
import { buildInlinedContext } from "./inline.js";
import type { ContextProfile, NeighborEntry, TargetRow } from "./types.js";

function neighborFromRow(r: Record<string, unknown>, distance: number): NeighborEntry {
  const st = summaryState({
    semantic_summary: (r.semantic_summary as string) ?? null,
    summary_of_hash: (r.summary_of_hash as string) ?? null,
    content_hash: (r.content_hash as string) ?? null,
  });
  const entry: NeighborEntry = {
    id: r.id as string,
    name: (r.name as string) ?? "",
    summary: st.summary,
    stale: st.stale,
    needs_enrichment: st.needsEnrichment,
    distance,
  };
  if (r.resolution !== undefined && r.resolution !== null) entry.resolution = r.resolution as string;
  if (r.confidence !== undefined && r.confidence !== null) entry.confidence = r.confidence as number;
  return entry;
}

const NEIGHBOR_RETURN =
  "AS id, x.qualified_name AS name, x.semantic_summary AS semantic_summary, " +
  "x.summary_of_hash AS summary_of_hash, x.content_hash AS content_hash";

const MAX_NEIGHBORS = 25;

/** Builds the full context profile for an already-resolved target. Hops is
 *  hard-capped at 2 (PRD §10.1). */
export async function assembleProfile(
  store: GraphStore,
  repo: string,
  target: TargetRow,
  hops: 1 | 2
): Promise<ContextProfile> {
  const id = target.id;

  // Upstream: direct callers — scoped to repo, fetch one extra to detect truncation.
  const upRows = await store.runRead(
    `MATCH (x:Function {repo_id:$repo})-[r:CALLS]->(t:Rs {id:$id}) ` +
      `RETURN x.id ${NEIGHBOR_RETURN}, r.resolution AS resolution, r.confidence AS confidence LIMIT ${MAX_NEIGHBORS + 1}`,
    { id, repo }
  );
  const upstreamRaw = upRows.map((r) => neighborFromRow(r, 1));
  const upstreamTruncated = upstreamRaw.length > MAX_NEIGHBORS;
  const upstream = upstreamRaw.slice(0, MAX_NEIGHBORS);

  // Downstream: direct callees (distance 1, with edge props) — scoped to repo.
  const downRows = await store.runRead(
    `MATCH (t:Rs {id:$id})-[r:CALLS]->(x:Function {repo_id:$repo}) ` +
      `RETURN x.id ${NEIGHBOR_RETURN}, r.resolution AS resolution, r.confidence AS confidence LIMIT ${MAX_NEIGHBORS + 1}`,
    { id, repo }
  );
  const downstreamRaw = downRows.map((r) => neighborFromRow(r, 1));
  let downstreamTruncated = downstreamRaw.length > MAX_NEIGHBORS;
  const downstream = downstreamRaw.slice(0, MAX_NEIGHBORS);

  if (hops === 2) {
    const seen = new Set(downstream.map((d) => d.id));
    seen.add(id);
    const d2 = await store.runRead(
      `MATCH (t:Rs {id:$id})-[:CALLS*2..2]->(x:Function {repo_id:$repo}) ` +
        `RETURN DISTINCT x.id ${NEIGHBOR_RETURN}`,
      { id, repo }
    );
    for (const r of d2) {
      const e = neighborFromRow(r, 2);
      if (!seen.has(e.id)) {
        if (downstream.length >= MAX_NEIGHBORS) {
          downstreamTruncated = true;
          break;
        }
        downstream.push(e);
        seen.add(e.id);
      }
    }
  }

  const tState = summaryState(target);
  const profTarget = {
    id: target.id,
    name: target.qualified_name,
    file_path: target.file_path,
    lines: [target.start_line, target.end_line] as [number, number],
    summary: tState.summary,
    stale: tState.stale,
  };

  const enrichment_needed = [
    ...(tState.needsEnrichment ? [target.id] : []),
    ...downstream.filter((d) => d.needs_enrichment).map((d) => d.id),
  ];

  let inlined = buildInlinedContext(profTarget, upstream, downstream);
  if (upstreamTruncated) {
    const extra = upstreamRaw.length - MAX_NEIGHBORS;
    inlined += ` (+${extra} more callers not shown — query read_cypher for the full set.)`;
  }
  if (downstreamTruncated) {
    inlined += ` (downstream list truncated — query read_cypher for the full set.)`;
  }

  return {
    target: profTarget,
    upstream,
    downstream,
    inlined_context: inlined,
    enrichment_needed,
    truncated: { upstream: upstreamTruncated, downstream: downstreamTruncated },
  };
}
