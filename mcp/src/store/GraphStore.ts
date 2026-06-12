/** Storage abstraction (PRD §4.2). The MCP server talks to Neo4j only through
 *  this. `runWrite`/`bulkImport`/`export` arrive with later tools; M2a needs
 *  only read access. */
export interface GraphStore {
  runRead(
    query: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<Record<string, unknown>[]>;
  runWrite(
    query: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}
