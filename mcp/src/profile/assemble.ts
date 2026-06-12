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

/** Builds the full context profile for an already-resolved target. Hops is
 *  hard-capped at 2 (PRD §10.1). */
export async function assembleProfile(
  store: GraphStore,
  repo: string,
  target: TargetRow,
  hops: 1 | 2
): Promise<ContextProfile> {
  const id = target.id;

  // Upstream: direct callers.
  const upRows = await store.runRead(
    `MATCH (x:Function)-[r:CALLS]->(t:Rs {id:$id}) ` +
      `RETURN x.id ${NEIGHBOR_RETURN}, r.resolution AS resolution, r.confidence AS confidence`,
    { id }
  );
  const upstream = upRows.map((r) => neighborFromRow(r, 1));

  // Downstream: direct callees (distance 1, with edge props).
  const downRows = await store.runRead(
    `MATCH (t:Rs {id:$id})-[r:CALLS]->(x:Function) ` +
      `RETURN x.id ${NEIGHBOR_RETURN}, r.resolution AS resolution, r.confidence AS confidence`,
    { id }
  );
  const downstream = downRows.map((r) => neighborFromRow(r, 1));

  if (hops === 2) {
    const seen = new Set(downstream.map((d) => d.id));
    seen.add(id);
    const d2 = await store.runRead(
      `MATCH (t:Rs {id:$id})-[:CALLS*2..2]->(x:Function) ` +
        `RETURN DISTINCT x.id ${NEIGHBOR_RETURN}`,
      { id }
    );
    for (const r of d2) {
      const e = neighborFromRow(r, 2);
      if (!seen.has(e.id)) {
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

  return {
    target: profTarget,
    upstream,
    downstream,
    inlined_context: buildInlinedContext(profTarget, upstream, downstream),
    enrichment_needed,
  };
}
