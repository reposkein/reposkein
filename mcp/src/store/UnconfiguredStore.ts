import type { GraphStore } from "./GraphStore.js";

const MSG =
  "Neo4j not configured: set NEO4J_PASSWORD and run `docker compose up` in indexer/";

/** A no-op store used when NEO4J_PASSWORD is absent.
 *  All read/write operations reject with an instructive error. */
export class UnconfiguredStore implements GraphStore {
  async runRead(): Promise<Record<string, unknown>[]> {
    throw new Error(MSG);
  }

  async runWrite(): Promise<Record<string, unknown>[]> {
    throw new Error(MSG);
  }

  async close(): Promise<void> {
    // nothing to close
  }
}
