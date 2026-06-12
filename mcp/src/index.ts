import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Neo4jGraphStore } from "./store/Neo4jGraphStore.js";
import { makeReadCypher } from "./tools/readCypher.js";

export async function main(): Promise<void> {
  const store = Neo4jGraphStore.fromEnv();
  const repoId = process.env.REPOSKEIN_REPO_ID;

  const server = new McpServer({ name: "@reposkein/mcp", version: "0.0.0" });
  const readCypher = makeReadCypher(store, repoId);

  server.registerTool(
    "read_cypher",
    {
      title: "Read-only Cypher query",
      description:
        "Run a read-only Cypher query against the RepoSkein graph. Writes are rejected. Filter by $repo_id to scope to the current repository. Results are capped (200 rows / 64KB).",
      inputSchema: {
        query: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        federated: z.boolean().optional(),
      },
    },
    async (args) => readCypher(args)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run when invoked as the binary (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
