import type {
  GraphStore,
  NeighborRow,
  SummaryFields,
  WriteSummaryResult,
} from "./GraphStore.js";
import type { TargetRow } from "../profile/types.js";

const MSG =
  "Neo4j not configured: set NEO4J_PASSWORD and run `docker compose up` in indexer/";

/** A no-op store used when NEO4J_PASSWORD is absent.
 *  All operations reject with an instructive error. */
export class UnconfiguredStore implements GraphStore {
  async getNode(_repoId: string, _id: string): Promise<TargetRow | null> {
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
  async runRead(): Promise<Record<string, unknown>[]> {
    throw new Error(MSG);
  }
  async close(): Promise<void> {
    // nothing to close
  }
}
