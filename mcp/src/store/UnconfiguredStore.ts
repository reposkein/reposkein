import type {
  CorpusNode,
  GraphStore,
  NeighborRow,
  SummaryFields,
  WriteSummaryResult,
} from "./GraphStore.js";
import type { TargetRow } from "../profile/types.js";

// Reached when no backend resolved. The common cause is a missing
// REPOSKEIN_REPO_PATH, not a missing database: `.reposkein/nodes.jsonl` is
// derived and git-ignored, and the server builds it on startup when it can, so
// pointing the user straight at Neo4j would send them to set up infrastructure
// they do not need.
const MSG =
  "RepoSkein has no graph for this repository. Set REPOSKEIN_REPO_PATH to the repository root: " +
  "nodes.jsonl and edges.jsonl are derived and git-ignored, so they are built on first use. " +
  "To build one by hand, run `reposkein-mcp index <repo>`. " +
  "To query a Neo4j-backed graph instead, set NEO4J_PASSWORD.";

/** A no-op store used when NEO4J_PASSWORD is absent.
 *  All operations reject with an instructive error. */
export class UnconfiguredStore implements GraphStore {
  async getNode(_repoIds: string[], _id: string): Promise<TargetRow | null> {
    throw new Error(MSG);
  }
  async resolveByPathAndName(): Promise<TargetRow[]> {
    throw new Error(MSG);
  }
  async resolveByName(): Promise<TargetRow[]> {
    throw new Error(MSG);
  }
  async callers(): Promise<NeighborRow[]> {
    throw new Error(MSG);
  }
  async callees(): Promise<NeighborRow[]> {
    throw new Error(MSG);
  }
  async calleesAt2Hops(): Promise<NeighborRow[]> {
    throw new Error(MSG);
  }
  async writeSummary(
    _repoId: string,
    _id: string,
    _fields: SummaryFields
  ): Promise<WriteSummaryResult> {
    throw new Error(MSG);
  }
  async federatedRepoIds(): Promise<string[]> {
    throw new Error(MSG);
  }
  async searchCorpus(_repoIds: string[]): Promise<CorpusNode[]> {
    return [];
  }
  async runRead(): Promise<Record<string, unknown>[]> {
    throw new Error(MSG);
  }
  async close(): Promise<void> {
    // nothing to close
  }
}
