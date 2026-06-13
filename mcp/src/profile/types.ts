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
}

export interface ProfileTarget {
  id: string;
  name: string;
  file_path: string;
  lines: [number, number];
  summary: string | null;
  stale: boolean;
  repo_id?: string;
}

export interface ContextProfile {
  target: ProfileTarget;
  upstream: NeighborEntry[];
  downstream: NeighborEntry[];
  inlined_context: string;
  enrichment_needed: string[];
  truncated?: { upstream: boolean; downstream: boolean };
}

export type ResolveResult =
  | { kind: "found"; target: TargetRow }
  | { kind: "candidates"; candidates: TargetRow[] }
  | { kind: "not_found" };
