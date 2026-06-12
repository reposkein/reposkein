import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Neo4jGraphStore } from "./store/Neo4jGraphStore.js";
import { UnconfiguredStore } from "./store/UnconfiguredStore.js";
import type { GraphStore } from "./store/GraphStore.js";
import { makeReadCypher } from "./tools/readCypher.js";
import { makeGetContextProfile } from "./tools/getContextProfile.js";
import { makeWriteSemanticSummary } from "./tools/writeSemanticSummary.js";
import { makeInitCpgSkeleton, makeReindexFile } from "./tools/indexerTools.js";
import { resolveRepoId } from "./store/repoId.js";

/** Lazy store: returns a real Neo4j store if configured, otherwise UnconfiguredStore. */
function buildStore(): GraphStore {
  try {
    return Neo4jGraphStore.fromEnv();
  } catch {
    return new UnconfiguredStore();
  }
}

const REPO_REQUIRED_MSG =
  "REPOSKEIN_REPO_PATH (or REPOSKEIN_REPO_ID) must be set to use this tool. " +
  "Set REPOSKEIN_REPO_PATH to the root of the repository you want to work with.";

export async function main(): Promise<void> {
  const store = buildStore();
  const repoId = resolveRepoId(process.env.REPOSKEIN_REPO_PATH, process.env.REPOSKEIN_REPO_ID);

  const server = new McpServer({ name: "@reposkein/mcp", version: "0.0.0" });
  const readCypher = makeReadCypher(store, repoId);

  server.registerTool(
    "read_cypher",
    {
      title: "Read-only Cypher query",
      description:
        "Run a read-only Cypher query against the RepoSkein graph. Writes are rejected. Filter by `n.repo_id = $repo_id` (or `n.repo_id IN $repo_ids`); pass `federated: true` to span this repo and its nested repos via `$repo_ids`. Results are capped (200 rows / 64KB).",
      inputSchema: {
        query: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        federated: z.boolean().optional(),
      },
    },
    async (args) => readCypher(args)
  );

  // Repo-scoped tools are always registered; they check repoId at call time.
  // Handlers are constructed with a real repoId only if it's available.
  const getContextProfile = repoId ? makeGetContextProfile(store, repoId) : null;
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
    async (args) => {
      if (!getContextProfile) {
        return { content: [{ type: "text", text: REPO_REQUIRED_MSG }], isError: true };
      }
      return getContextProfile(args);
    }
  );

  const writeSummary = repoId ? makeWriteSemanticSummary(store, repoId) : null;
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
    async (args) => {
      if (!writeSummary) {
        return { content: [{ type: "text", text: REPO_REQUIRED_MSG }], isError: true };
      }
      return writeSummary(args);
    }
  );

  const initSkeleton = repoId ? makeInitCpgSkeleton(repoId) : null;
  server.registerTool(
    "init_cpg_skeleton",
    {
      title: "Build the code graph",
      description:
        "Index the repository with the native indexer and load it into the graph database. Run once on a fresh repo (or to rebuild). Returns node/edge counts.",
      inputSchema: {
        path: z.string().optional(),
        full: z.boolean().optional(),
      },
    },
    async (args) => {
      if (!initSkeleton) {
        return { content: [{ type: "text", text: REPO_REQUIRED_MSG }], isError: true };
      }
      return initSkeleton(args);
    }
  );

  const reindexFile = repoId ? makeReindexFile(repoId) : null;
  server.registerTool(
    "reindex_file",
    {
      title: "Reindex after editing",
      description:
        "Refresh the graph after editing a source file (pass its path). v1 performs a full reindex.",
      inputSchema: { path: z.string() },
    },
    async (args) => {
      if (!reindexFile) {
        return { content: [{ type: "text", text: REPO_REQUIRED_MSG }], isError: true };
      }
      return reindexFile(args);
    }
  );

  if (!repoId) {
    console.error(
      "[reposkein-mcp] REPOSKEIN_REPO_PATH not set; repo-scoped tools will return an error until it is configured"
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run when invoked as the binary (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
