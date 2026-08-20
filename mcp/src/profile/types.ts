export interface TargetRow {
  id: string;
  repo_id: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  semantic_summary: string | null;
  summary_of_hash: string | null;
  content_hash: string | null;
  labels: string[];
}

export interface NeighborEntry {
  id: string;
  name: string;
  summary: string | null;
  stale: boolean;
  needs_enrichment: boolean;
  resolution?: string;
  confidence?: number;
  distance?: number;
  repo_id?: string;
  /** True for a cross-repo (federation-stitched) neighbor. */
  cross_repo?: boolean;
}

export interface ProfileTarget {
  id: string;
  name: string;
  file_path: string;
  lines: [number, number];
  summary: string | null;
  stale: boolean;
  repo_id?: string;
  /** ADRs governing this node (max 5) — see profile/decisions.ts. Absent when
   *  the repo has no decisions touching it. */
  decisions?: import("./decisions.js").GoverningDecision[];
}

export interface ContextProfile {
  target: ProfileTarget;
  upstream: NeighborEntry[];
  downstream: NeighborEntry[];
  inlined_context: string;
  enrichment_needed: string[];
  /** Accepted decisions whose anchor on the target went stale. Deliberately
   *  NOT folded into enrichment_needed — that field's contract is node ids
   *  fed to write_semantic_summary. Re-read these and conform / supersede /
   *  reaffirm instead. */
  decisions_needing_review?: string[];
  truncated?: { upstream: boolean; downstream: boolean };
}

export type ResolveResult =
  | { kind: "found"; target: TargetRow }
  | { kind: "candidates"; candidates: TargetRow[] }
  | { kind: "not_found" };
