import neo4j, { type Driver } from "neo4j-driver";
import type { GraphStore } from "./GraphStore.js";

export class Neo4jGraphStore implements GraphStore {
  private driver: Driver;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      disableLosslessIntegers: true,
    });
  }

  /** Connect using env: NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD. */
  static fromEnv(): Neo4jGraphStore {
    const uri = process.env.NEO4J_URI ?? "neo4j://localhost:7687";
    const user = process.env.NEO4J_USER ?? "neo4j";
    const password = process.env.NEO4J_PASSWORD;
    if (!password) throw new Error("NEO4J_PASSWORD must be set");
    return new Neo4jGraphStore(uri, user, password);
  }

  async runRead(
    query: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>[]> {
    const session = this.driver.session({
      defaultAccessMode: neo4j.session.READ,
    });
    try {
      const result = await session.run(query, params, {
        timeout: opts.timeoutMs ?? 10_000,
      });
      return result.records.map((r) => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  async runWrite(
    query: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {}
  ): Promise<Record<string, unknown>[]> {
    const session = this.driver.session({
      defaultAccessMode: neo4j.session.WRITE,
    });
    try {
      const result = await session.run(query, params, {
        timeout: opts.timeoutMs ?? 10_000,
      });
      return result.records.map((r) => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
