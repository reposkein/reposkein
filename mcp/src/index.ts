import { pathToFileURL } from "node:url";
import { runInit } from "./cli/init.js";
import { runDoctor } from "./cli/doctor.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Neo4jGraphStore } from "./store/Neo4jGraphStore.js";
import { UnconfiguredStore } from "./store/UnconfiguredStore.js";
import type { GraphStore } from "./store/GraphStore.js";
import { JsonlGraphStore } from "./store/JsonlGraphStore.js";
import { makeReadCypher } from "./tools/readCypher.js";
import { makeGetContextProfile } from "./tools/getContextProfile.js";
import { makeWriteSemanticSummary } from "./tools/writeSemanticSummary.js";
import { makeInitCpgSkeleton, makeReindexFile } from "./tools/indexerTools.js";
import { makeSemanticFind } from "./tools/semanticFind.js";
import { makeTemporalContext } from "./tools/temporalContext.js";
import { resolveRepoId } from "./store/repoId.js";

/** Selects the store backend.
 *  REPOSKEIN_STORE = "jsonl" | "neo4j" | "auto" (default "auto").
 *  - auto: JSONL if <repoPath>/.reposkein/nodes.jsonl exists, else Neo4j if
 *    NEO4J_PASSWORD is set, else Unconfigured.
 *  - jsonl: JSONL if available, else Unconfigured.
 *  - neo4j: Neo4j if configured, else Unconfigured. */
function buildStore(repoPath: string | undefined, repoId: string | undefined): GraphStore {
  const mode = (process.env.REPOSKEIN_STORE ?? "auto").toLowerCase();
  const jsonlReady =
    !!repoPath && !!repoId && existsSync(join(repoPath, ".reposkein", "nodes.jsonl"));

  const neo4j = (): GraphStore => {
    try {
      return Neo4jGraphStore.fromEnv();
    } catch {
      return new UnconfiguredStore();
    }
  };

  if (mode === "jsonl") {
    return jsonlReady ? new JsonlGraphStore(repoPath!, repoId!) : new UnconfiguredStore();
  }
  if (mode === "neo4j") {
    return neo4j();
  }
  // auto
  if (jsonlReady) return new JsonlGraphStore(repoPath!, repoId!);
  return neo4j();
}

const REPO_REQUIRED_MSG =
  "REPOSKEIN_REPO_PATH (or REPOSKEIN_REPO_ID) must be set to use this tool. " +
  "Set REPOSKEIN_REPO_PATH to the root of the repository you want to work with.";

export async function main(): Promise<void> {
  const repoPath = process.env.REPOSKEIN_REPO_PATH;
  const repoId = resolveRepoId(repoPath, process.env.REPOSKEIN_REPO_ID);
  const store = buildStore(repoPath, repoId);

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
        "Resolve a function/class (by node_id, file_path+name, or name) and return its caller/callee neighborhood (hops 1-2) with inlined prose and an enrichment_needed list. Never guesses — returns candidates if a name is ambiguous. Pass federated:true to resolve and traverse across nested repos.",
      inputSchema: {
        node_id: z.string().optional(),
        file_path: z.string().optional(),
        name: z.string().optional(),
        hops: z.union([z.literal(1), z.literal(2)]).optional(),
        federated: z.boolean().optional(),
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

  const semanticFind = repoId ? makeSemanticFind(store, repoId, repoPath ?? ".") : null;
  server.registerTool(
    "semantic_find",
    {
      title: "Find code by meaning",
      description:
        "Rank functions/classes by a lexical match over their qualified names, signatures, and agent-written summaries — the entry point to seed get_context_profile when you don't know where to start. Returns ranked node_ids. federated:true spans nested repos.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional(),
        kind: z.enum(["Function", "Class", "Interface", "Enum"]).optional(),
        federated: z.boolean().optional(),
      },
    },
    async (args) => {
      if (!semanticFind) {
        return { content: [{ type: "text", text: REPO_REQUIRED_MSG }], isError: true };
      }
      return semanticFind(args);
    }
  );

  // get_temporal_context is gated on repoPath (not the store — it reads from .git directly).
  const temporalContext = repoPath ? makeTemporalContext(repoPath) : null;
  server.registerTool(
    "get_temporal_context",
    {
      title: "Git temporal context",
      description:
        "Git-derived signals for a file: how often/recently it changes, who owns it, and which files most often change together with it (co-change) — answers \"what else should I touch?\". Advisory (derived from git history, not the committed graph). Before a cross-cutting change, use this to find files that historically change together.",
      inputSchema: { path: z.string() },
    },
    async (args) => {
      if (!temporalContext) {
        return { content: [{ type: "text", text: REPO_REQUIRED_MSG }], isError: true };
      }
      return temporalContext(args);
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
  const sub = process.argv[2];
  if (sub === "init") {
    runInit(process.argv[3] ?? ".")
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else if (sub === "doctor") {
    const rest = process.argv.slice(3);
    const json = rest.includes("--json");
    const path = rest.find((a) => !a.startsWith("-")) ?? process.env.REPOSKEIN_REPO_PATH ?? ".";
    runDoctor(path, json)
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else {
    main().catch((err) => { console.error(err); process.exit(1); });
  }
}
