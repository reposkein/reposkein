import type { GraphStore, NeighborRow } from "../store/GraphStore.js";
import { summaryState } from "./summary.js";
import { buildInlinedContext } from "./inline.js";
import type { ContextProfile, NeighborEntry, TargetRow } from "./types.js";

function neighborFromRow(r: NeighborRow, distance: number): NeighborEntry {
  const st = summaryState({
    semantic_summary: r.semantic_summary,
    summary_of_hash: r.summary_of_hash,
    content_hash: r.content_hash,
  });
  const entry: NeighborEntry = {
    id: r.id,
    name: r.name ?? "",
    summary: st.summary,
    stale: st.stale,
    needs_enrichment: st.needsEnrichment,
    distance,
  };
  if (r.resolution !== undefined) entry.resolution = r.resolution;
  if (r.confidence !== undefined) entry.confidence = r.confidence;
  return entry;
}

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

  // Upstream: direct callers — fetch one extra to detect truncation.
  const upRows = await store.callers(repo, id, MAX_NEIGHBORS + 1);
  const upstreamRaw = upRows.map((r) => neighborFromRow(r, 1));
  const upstreamTruncated = upstreamRaw.length > MAX_NEIGHBORS;
  const upstream = upstreamRaw.slice(0, MAX_NEIGHBORS);

  // Downstream: direct callees (distance 1, with edge props).
  const downRows = await store.callees(repo, id, MAX_NEIGHBORS + 1);
  const downstreamRaw = downRows.map((r) => neighborFromRow(r, 1));
  let downstreamTruncated = downstreamRaw.length > MAX_NEIGHBORS;
  const downstream = downstreamRaw.slice(0, MAX_NEIGHBORS);

  if (hops === 2) {
    const seen = new Set(downstream.map((d) => d.id));
    seen.add(id);
    const d2 = await store.calleesAt2Hops(repo, id, MAX_NEIGHBORS + 1);
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
