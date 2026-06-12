import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Neo4jGraphStore } from "./store/Neo4jGraphStore.js";
import { makeReadCypher } from "./tools/readCypher.js";
import { makeGetContextProfile } from "./tools/getContextProfile.js";
import { makeWriteSemanticSummary } from "./tools/writeSemanticSummary.js";

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

  if (repoId) {
    const getContextProfile = makeGetContextProfile(store, repoId);
    server.registerTool(
      "get_context_profile",
      {
        title: "Get context profile",
        description:
          "Resolve a function/class (by node_id, file_path+name, or name) and return its caller/callee neighborhood (hops 1-2) with inlined prose and an enrichment_needed list. Never guesses — returns candidates if a name is ambiguous.",
        inputSchema: {
          node_id: z.string().optional(),
          file_path: z.string().optional(),
          name: z.string().optional(),
          hops: z.union([z.literal(1), z.literal(2)]).optional(),
        },
      },
      async (args) => getContextProfile(args)
    );
    const writeSummary = makeWriteSemanticSummary(store, repoId);
    server.registerTool(
      "write_semantic_summary",
      {
        title: "Write semantic summary",
        description:
          "Attach a 1-3 sentence plain-text business-logic summary to a node, stamped with its current content hash for staleness tracking. Plain text only (no markdown links or code fences), max 1000 chars.",
        inputSchema: {
          node_id: z.string(),
          summary: z.string(),
          model: z.string().optional(),
        },
      },
      async (args) => writeSummary(args)
    );
  } else {
    console.error("[reposkein-mcp] REPOSKEIN_REPO_ID not set; get_context_profile disabled");
  }

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
