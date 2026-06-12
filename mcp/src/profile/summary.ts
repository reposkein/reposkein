export interface SummaryInput {
  semantic_summary: string | null;
  summary_of_hash: string | null;
  content_hash: string | null;
}

export interface SummaryState {
  summary: string | null;
  stale: boolean;
  needsEnrichment: boolean;
}

/** Derives summary freshness (PRD §3.6): a summary is stale when the hash it
 *  was written against no longer matches the node's current content_hash. */
export function summaryState(props: SummaryInput): SummaryState {
  const summary = props.semantic_summary ?? null;
  if (!summary) {
    return { summary: null, stale: false, needsEnrichment: true };
  }
  const stale = props.summary_of_hash !== props.content_hash;
  return { summary, stale, needsEnrichment: stale };
}
