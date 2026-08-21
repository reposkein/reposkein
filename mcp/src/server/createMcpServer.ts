import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jGraphStore } from "../store/Neo4jGraphStore.js";
import { UnconfiguredStore } from "../store/UnconfiguredStore.js";
import type { GraphStore } from "../store/GraphStore.js";
import { JsonlGraphStore } from "../store/JsonlGraphStore.js";
import { makeReadCypher } from "../tools/readCypher.js";
import type { ToolResult } from "../tools/readCypher.js";
import { makeGetContextProfile } from "../tools/getContextProfile.js";
import { makeWriteSemanticSummary } from "../tools/writeSemanticSummary.js";
import { makeInitCpgSkeleton, makeReindexFile } from "../tools/indexerTools.js";
import { makeSemanticFind } from "../tools/semanticFind.js";
import { makeTemporalContext } from "../tools/temporalContext.js";
import { makeImpact } from "../tools/impact.js";
import { makeRecordDecision } from "../tools/recordDecision.js";
import { makeSetDecisionStatus } from "../tools/setDecisionStatus.js";
import { makeReaffirmDecision } from "../tools/reaffirmDecision.js";
import { makeListDecisions } from "../tools/listDecisions.js";
import { makeGetDecision } from "../tools/getDecision.js";
import { resolveRepoId } from "../store/repoId.js";
import type { RepoResolution } from "../store/resolveRepoPath.js";
import { RepoSession } from "../store/repoSession.js";
import { makeCache } from "../store/repoContextCache.js";
import { ensureGraph } from "../indexer/ensureGraph.js";
import { ensureIndexerBinary } from "../indexer/fetchBinary.js";
import { spawnIndexer } from "../indexer/runIndexer.js";
import { SessionLogger, resolveSessionId } from "../store/sessionLog.js";
import { createToolLogger } from "../store/instrumentTool.js";

/** Selects the store backend.
 *  REPOSKEIN_STORE = "jsonl" | "neo4j" | "auto" (default "auto").
 *  - auto: JSONL if <repoPath>/.reposkein/nodes.jsonl exists, else Neo4j if
 *    NEO4J_PASSWORD is set, else Unconfigured.
 *  - jsonl: JSONL if available, else Unconfigured.
 *  - neo4j: Neo4j if configured, else Unconfigured.
 *
 *  `agent` names the writer for sidecar selection (one summaries file per
 *  agent, see store/sidecar.ts); undefined keeps the REPOSKEIN_AGENT default. */
export function buildStore(
  repoPath: string | undefined,
  repoId: string | undefined,
  agent?: string
): GraphStore {
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
    return jsonlReady ? new JsonlGraphStore(repoPath!, repoId!, agent) : new UnconfiguredStore();
  }
  if (mode === "neo4j") {
    return neo4j();
  }
  // auto
  if (jsonlReady) return new JsonlGraphStore(repoPath!, repoId!, agent);
  return neo4j();
}

/** Structured, actionable message for repo-scoped tool calls when no repo
 *  resolved (see `resolveRepoPath`). Names the discovered candidates when
 *  resolution failed due to workspace-mode ambiguity, and points at
 *  `list_repos` / `select_repo` so the agent can pick one instead of
 *  abandoning the tools. */
export function repoRequiredMessage(resolution: RepoResolution): string {
  if (resolution.candidates && resolution.candidates.length > 0) {
    return (
      `Multiple RepoSkein repos were found under ${process.cwd()} and none is selected: ` +
      resolution.candidates.join(", ") +
      ". Call list_repos to see them, then select_repo with one of its `path` or `name` " +
      "values (or set REPOSKEIN_REPO_PATH) to use this tool."
    );
  }
  return (
    "No RepoSkein repo found (checked the current directory, its ancestors, and its " +
    "immediate subdirectories for .reposkein/). Run `reposkein-mcp init` in the repository " +
    "you want to work with, call list_repos to check what was discovered, or set " +
    "REPOSKEIN_REPO_PATH to its root."
  );
}

/** A repo resolved but has no committed `meta.json` (never indexed). */
export function repoUnindexedMessage(repoPath: string): string {
  if (existsSync(join(repoPath, ".reposkein"))) {
    return (
      `Found .reposkein/ at ${repoPath}, but it has no meta.json (not indexed yet). ` +
      `Run \`reposkein-mcp index ${repoPath}\` (or the init_cpg_skeleton tool) to build it, ` +
      "then retry this call."
    );
  }
  return (
    `${repoPath} has no .reposkein/ directory. Run \`reposkein-mcp init ${repoPath}\` there, ` +
    "or point REPOSKEIN_REPO_PATH / select_repo at a repo that already has one."
  );
}

/** Whether a graph is available to READ at `repoPath` without building one.
 *
 *  Mirrors `buildStore`'s backend choice exactly (same env, same order), so
 *  "we can serve reads" and "we picked a real store" can never disagree:
 *  explicit neo4j mode trusts the DB, otherwise the committed-derived JSONL
 *  decides, and `auto` falls back to Neo4j when a password is configured. */
export function graphAvailable(repoPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.REPOSKEIN_STORE ?? "auto").toLowerCase();
  if (mode === "neo4j") return true;
  if (existsSync(join(repoPath, ".reposkein", "nodes.jsonl"))) return true;
  return mode === "auto" && !!env.NEO4J_PASSWORD;
}

/** A read-only connection resolved a repo whose derived graph isn't built.
 *
 *  Building it means spawning the indexer and writing `.reposkein/*.jsonl` —
 *  a write, and the LAST write a read-only token could still trigger, since
 *  `ensureGraph` used to run unconditionally on first touch of any repo. So a
 *  read-only caller gets this instead: an explanation and the exact command
 *  for whoever does hold write access, with nothing changed on disk. */
export function readOnlyUnindexedMessage(repoPath: string): string {
  return (
    `${repoPath} has no built graph (.reposkein/nodes.jsonl is derived from the working tree ` +
    "and git-ignored, so a fresh clone has none), and this connection is read-only — the " +
    "server will not build one for it. Ask the operator to run " +
    `\`reposkein-mcp index ${repoPath}\`, or use a write-capable token. Nothing was changed.`
  );
}

/** Exported for schema tests. */
export const getContextProfileInputSchema = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  name: z.string().optional(),
  hops: z.number().int().min(1).max(2).optional(),
  federated: z.boolean().optional(),
};

/** Exported for schema tests. */
export const recordDecisionInputSchema = {
  title: z.string(),
  context: z.string(),
  decision: z.string(),
  consequences: z.string().optional(),
  alternatives: z.string().optional(),
  status: z.enum(["proposed", "accepted"]).optional(),
  anchor_node_ids: z.array(z.string()).max(20).optional(),
  anchor_paths: z.array(z.string()).max(20).optional(),
  supersedes: z.array(z.string()).max(5).optional(),
};

export const setDecisionStatusInputSchema = {
  decision_id: z.string(),
  status: z.enum(["accepted", "rejected", "deprecated"]),
};

export const reaffirmDecisionInputSchema = {
  decision_id: z.string(),
};

export const listDecisionsInputSchema = {
  status: z.enum(["proposed", "accepted", "rejected", "deprecated", "superseded"]).optional(),
  anchor: z.string().optional(),
  q: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

export const getDecisionInputSchema = {
  decision_id: z.string(),
};

/** The tools that MUTATE the repo (sidecar prose, decision records, the
 *  derived graph). Gated behind the `write` capability in `serve --http`
 *  (REP-17); always available over stdio, where the caller already owns the
 *  checkout.
 *
 *  `select_repo` is deliberately NOT here: it mutates only this connection's
 *  own `RepoSession`, which since REP-17 is per-connection state, so a
 *  read-only caller pointing itself at a different discovered repo affects
 *  nobody else. */
export const WRITE_TOOLS = [
  "write_semantic_summary",
  "record_decision",
  "set_decision_status",
  "reaffirm_decision",
  "reindex_file",
  "init_cpg_skeleton",
] as const;

export interface ToolCapabilities {
  /** False = read-only connection: every WRITE_TOOLS call is refused. */
  write: boolean;
}

export interface CreateMcpServerOptions {
  /** Working directory repo discovery starts from. */
  cwd: string;
  /** REPOSKEIN_REPO_PATH, or undefined. */
  envRepoPath: string | undefined;
  /** Session-log id. Defaults to `resolveSessionId(process.env)` (the stdio
   *  behaviour: one id per server process). */
  sessionId?: string;
  /** Writer identity recorded as `summary_by`/`decided_by` and used to pick
   *  the per-agent sidecar file. Undefined keeps the historical
   *  `REPOSKEIN_AGENT ?? "agent"` fallback inside the tools. */
  identity?: string;
  /** Defaults to `{ write: true }` — the stdio behaviour. */
  capabilities?: ToolCapabilities;
  /** Test seam for the first-touch graph build. Defaults to the real
   *  `ensureGraph`. Injected in tests so the read-only build gate can be
   *  asserted (called / not called) without spawning an indexer. */
  ensureGraph?: typeof ensureGraph;
}

/** Builds ONE MCP server with its own session state.
 *
 *  Everything a caller can move — the active repo (`select_repo`), the
 *  per-repoPath store/context cache, the tool-call logger — lives in this
 *  closure, so two connections into the same process cannot see each other's
 *  selection. That is what makes `serve --http` (REP-17) safe; over stdio
 *  there is exactly one of these per process, which is byte-for-byte the
 *  behaviour that existed before the extraction. */
export function createMcpServer(opts: CreateMcpServerOptions): McpServer {
  const caps: ToolCapabilities = opts.capabilities ?? { write: true };
  const identity = opts.identity;
  const ensureGraphFn = opts.ensureGraph ?? ensureGraph;

  const session = new RepoSession({ cwd: opts.cwd, envRepoPath: opts.envRepoPath });
  const sessionLogger = new SessionLogger(opts.sessionId ?? resolveSessionId(process.env));
  const { withLog, cachedResolve } = createToolLogger(session, sessionLogger);

  const getRepoContext = makeCache(
    async (
      path: string
    ): Promise<{ repoId: string | undefined; store: GraphStore; graphReady: boolean }> => {
      const id = resolveRepoId(path, process.env.REPOSKEIN_REPO_ID);
      // REP-17: `ensureGraph` SPAWNS THE INDEXER and writes `.reposkein/*.jsonl`.
      // That is a write, so a read-only connection must not reach it — it was
      // the one mutation a read-only token could still cause, just by naming
      // an unbuilt repo. Read-only callers get `readOnlyUnindexedMessage`
      // below instead, and the repo is left exactly as it was found.
      if (caps.write) {
        await ensureGraphFn(path, id, {
          mode: (process.env.REPOSKEIN_STORE ?? "auto").toLowerCase(),
          neo4jConfigured: !!process.env.NEO4J_PASSWORD,
        });
      }
      return { repoId: id, store: buildStore(path, id, identity), graphReady: graphAvailable(path) };
    },
    // Write connections: cache exactly as before (repoId resolved). Read-only
    // connections additionally refuse to cache a graph-less resolution, so a
    // graph built out of band (by the operator, or by the HEAD watcher) is
    // picked up on the next call instead of sticking for the connection's life
    // — they have no way to fix it themselves.
    (ctx) => !!ctx.repoId && (caps.write || ctx.graphReady)
  );

  type ActiveRepo =
    | { ok: true; repoPath: string; repoId: string; store: GraphStore }
    | { ok: false; message: string };
  /** Resolves the session's current repo for a repo-scoped tool call.
   *  Re-evaluated on every call (not once at startup) so `select_repo`
   *  actually takes effect for calls made after it. Uses `cachedResolve`
   *  (not `session.resolve()` directly) so this and the REP-20 logging
   *  wrapper share one filesystem walk per call. */
  async function resolveActiveRepo(): Promise<ActiveRepo> {
    const resolution = cachedResolve();
    if (!resolution.repoPath) return { ok: false, message: repoRequiredMessage(resolution) };
    const ctx = await getRepoContext(resolution.repoPath);
    if (!ctx.repoId) return { ok: false, message: repoUnindexedMessage(resolution.repoPath) };
    if (!ctx.graphReady) {
      // Only reachable on a read-only connection: a write one already tried to
      // build above, and if THAT failed ensureGraph explained why on stderr and
      // the store degrades to Unconfigured (whose own error names the fix).
      if (!caps.write) return { ok: false, message: readOnlyUnindexedMessage(resolution.repoPath) };
    }
    return { ok: true, repoPath: resolution.repoPath, repoId: ctx.repoId, store: ctx.store };
  }
  const errResult = (message: string): ToolResult => ({
    content: [{ type: "text", text: message }],
    isError: true,
  });

  /** The refusal a read-only connection gets from a mutating tool. Structured
   *  (JSON with a stable `error` code) so an agent can branch on it instead of
   *  parsing prose, and it names the identity so an operator reading the
   *  transcript knows WHICH token was short of capability. Never echoes the
   *  token value. */
  const capabilityRefusal = (tool: string): ToolResult => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "write_capability_required",
          tool,
          required_capability: "write",
          identity: identity ?? null,
          detail:
            `This connection is read-only, so ${tool} was refused before it could change anything. ` +
            "Ask the operator for a token declared with the `write` capability " +
            "(`name:token:write`), or run the stdio server against your own checkout.",
        }),
      },
    ],
    isError: true,
  });

  /** Registration-time note appended to a mutating tool's description on a
   *  read-only connection, so `tools/list` is honest about what will happen. */
  const readOnlyNote =
    " NOTE: this connection's token is read-only — calling this tool returns a " +
    "`write_capability_required` error and changes nothing.";
  const describe = (text: string, tool: string): string =>
    caps.write || !(WRITE_TOOLS as readonly string[]).includes(tool) ? text : text + readOnlyNote;

  /** `withLog` plus the write-capability gate. The refusal is logged like any
   *  other failed call (ok:false), which is what an operator wants to see. */
  function withWrite<Args>(
    name: string,
    cb: (args: Args) => Promise<ToolResult>
  ): (args: Args) => Promise<ToolResult> {
    return withLog(name, async (args: Args) => {
      if (!caps.write) return capabilityRefusal(name);
      return cb(args);
    });
  }

  const server = new McpServer({ name: "@reposkein/mcp", version: "0.0.0" });

  server.registerTool(
    "list_repos",
    {
      title: "List discovered repos",
      description:
        "Enumerate the RepoSkein repos discovered from the server's working directory (walk-up: the nearest ancestor with .reposkein/; walk-down/workspace mode: subdirectories, when no ancestor has one). Single-repo setups return exactly one entry. In workspace mode (multiple sibling repos, no default selected), use this to see the candidates, then `select_repo` one before calling other repo-scoped tools.",
      inputSchema: {},
    },
    withLog("list_repos", async () => {
      const repos = session.list();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mode: repos.length > 1 ? "workspace" : "single",
              repos,
            }),
          },
        ],
      };
    })
  );

  server.registerTool(
    "select_repo",
    {
      title: "Select the active repo",
      description:
        "Set the session-active repo for all subsequent repo-scoped tool calls (get_context_profile, semantic_find, impact, decisions, etc.) — the fix for workspace-mode ambiguity (list_repos returned more than one candidate). Pass a `repo` value from list_repos: its `path` or its `name`. Overrides REPOSKEIN_REPO_PATH and any earlier select_repo call for the rest of this connection; stays in effect until called again.",
      inputSchema: { repo: z.string() },
    },
    withLog("select_repo", async (args) => {
      const result = session.select(args.repo);
      if (!result.ok) return errResult(result.error);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, selected: result.repo }) }],
      };
    })
  );

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
    withLog("read_cypher", async (args) => {
      // Cypher is store-level, not repo-scoped: a Neo4j-backed server answers
      // even with no local checkout resolved.
      const resolution = cachedResolve();
      const ctx = resolution.repoPath
        ? await getRepoContext(resolution.repoPath)
        : { repoId: undefined, store: buildStore(undefined, undefined, identity) };
      return makeReadCypher(ctx.store, ctx.repoId)(args);
    })
  );

  server.registerTool(
    "get_context_profile",
    {
      title: "Get context profile",
      description:
        "Resolve a function/class (by node_id, file_path+name, or name) and return its caller/callee neighborhood (hops 1-2) with inlined prose and an enrichment_needed list. Never guesses — returns candidates if a name is ambiguous. Pass federated:true to resolve and traverse across nested repos.",
      inputSchema: getContextProfileInputSchema,
    },
    withLog("get_context_profile", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeGetContextProfile(active.store, active.repoId, active.repoPath)(args);
    })
  );

  server.registerTool(
    "write_semantic_summary",
    {
      title: "Write semantic summary",
      description: describe(
        "Attach a 1-3 sentence plain-text business-logic summary to a node, stamped with its current content hash for staleness tracking. Plain text only (no markdown links or code fences), max 1000 chars.",
        "write_semantic_summary"
      ),
      inputSchema: {
        node_id: z.string(),
        summary: z.string(),
        model: z.string().optional(),
      },
    },
    withWrite("write_semantic_summary", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeWriteSemanticSummary(active.store, active.repoId, identity)(args);
    })
  );

  server.registerTool(
    "init_cpg_skeleton",
    {
      title: "Build the code graph",
      description: describe(
        "Index the repository with the native indexer and load it into the graph database. Run once on a fresh repo (or to rebuild). Returns node/edge counts.",
        "init_cpg_skeleton"
      ),
      inputSchema: {
        path: z.string().optional(),
        full: z.boolean().optional(),
      },
    },
    withWrite("init_cpg_skeleton", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeInitCpgSkeleton(active.repoId, active.repoPath)(args);
    })
  );

  server.registerTool(
    "reindex_file",
    {
      title: "Reindex after editing",
      description: describe(
        "Refresh the graph after editing a source file (pass its path). v1 performs a full reindex.",
        "reindex_file"
      ),
      inputSchema: { path: z.string() },
    },
    withWrite("reindex_file", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeReindexFile(active.repoId, active.repoPath)(args);
    })
  );

  server.registerTool(
    "semantic_find",
    {
      title: "Find code by meaning",
      description:
        "Rank functions/classes by a lexical match over their qualified names, signatures, and agent-written summaries — the entry point to seed get_context_profile when you don't know where to start. Returns ranked node_ids. Architecture decisions are part of the corpus: \"why\" questions (why don't we X, what did we decide about Y) surface Decision rows — follow up with get_decision. federated:true spans nested repos.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(25).optional(),
        kind: z.enum(["Function", "Class", "Interface", "Enum", "Decision"]).optional(),
        federated: z.boolean().optional(),
      },
    },
    withLog("semantic_find", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeSemanticFind(active.store, active.repoId, active.repoPath, undefined, {
        decisions: true,
      })(args);
    })
  );

  server.registerTool(
    "get_temporal_context",
    {
      title: "Git temporal context",
      description:
        "Git-derived signals for a file: how often/recently it changes, who owns it, and which files most often change together with it (co-change) — answers \"what else should I touch?\". Advisory (derived from git history, not the committed graph). Before a cross-cutting change, use this to find files that historically change together.",
      inputSchema: { path: z.string() },
    },
    withLog("get_temporal_context", async (args) => {
      // Git-derived, not graph-derived: needs a checkout, not an index.
      const resolution = cachedResolve();
      if (!resolution.repoPath) return errResult(repoRequiredMessage(resolution));
      return makeTemporalContext(resolution.repoPath)(args);
    })
  );

  server.registerTool(
    "impact",
    {
      title: "Change impact + covering tests",
      description:
        "Given a function/class, return its transitive callers (what could break if you change it) split into impacted code vs the tests that cover it (what to run). Resolves by node_id, file_path+name, or name. federated:true spans nested repos.",
      inputSchema: {
        node_id: z.string().optional(),
        file_path: z.string().optional(),
        name: z.string().optional(),
        depth: z.number().int().min(1).max(5).optional(),
        federated: z.boolean().optional(),
      },
    },
    withLog("impact", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeImpact(active.store, active.repoId, active.repoPath)(args);
    })
  );

  // --- Architecture Decision Records (ADRs) ---

  server.registerTool(
    "record_decision",
    {
      title: "Record an architecture decision",
      description: describe(
        "Record an Architecture Decision Record (ADR): why a significant design choice was made, anchored to the graph nodes and paths it governs. Use for decisions that affect structure, dependencies, interfaces, or construction techniques — not renames, formatting, or routine fixes. Records land as status \"proposed\" (the user ratifies via set_decision_status); pass supersedes to replace an earlier decision. Plain text only; anchors are stamped with the current content hash for drift tracking.",
        "record_decision"
      ),
      inputSchema: recordDecisionInputSchema,
    },
    withWrite("record_decision", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      // Refresh the graph before stamping anchors so a decision recorded
      // right after an edit isn't born stale. Best-effort inside the tool.
      const decisionRefresh = async (): Promise<void> => {
        const bin = await ensureIndexerBinary();
        await spawnIndexer(bin, ["index", "--json", "--repo-id", active.repoId, active.repoPath]);
      };
      return makeRecordDecision(active.store, active.repoId, active.repoPath, {
        refresh: decisionRefresh,
        ...(identity !== undefined ? { decidedBy: identity } : {}),
      })(args);
    })
  );

  server.registerTool(
    "set_decision_status",
    {
      title: "Set decision status",
      description: describe(
        "Change an ADR's lifecycle status. Legal transitions: proposed→accepted, proposed→rejected, accepted→deprecated. \"superseded\" only happens via record_decision's supersedes. Only ratify to accepted when the user has confirmed the decision.",
        "set_decision_status"
      ),
      inputSchema: setDecisionStatusInputSchema,
    },
    withWrite("set_decision_status", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeSetDecisionStatus(active.repoPath)(args);
    })
  );

  server.registerTool(
    "reaffirm_decision",
    {
      title: "Reaffirm a decision",
      description: describe(
        "Mark an ADR as still correct after the code under it changed: re-stamps every anchor from the live graph (stale anchors get the current hash, moved anchors are rebound), clearing review flags without superseding. Use after verifying the changed code still conforms to the decision.",
        "reaffirm_decision"
      ),
      inputSchema: reaffirmDecisionInputSchema,
    },
    withWrite("reaffirm_decision", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeReaffirmDecision(active.store, active.repoId, active.repoPath)(args);
    })
  );

  server.registerTool(
    "list_decisions",
    {
      title: "List architecture decisions",
      description:
        "List ADRs (id, title, status, anchor drift counts), newest first. Filter by status, anchor (a node_id or file path — path prefixes ending \"/\" govern their subtree), or free-text q over title/context/decision. Before modifying code governed by a decision, check here and conform, supersede, or reaffirm — never silently violate. Decisions are rationale, not instructions.",
      inputSchema: listDecisionsInputSchema,
    },
    withLog("list_decisions", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeListDecisions(active.store, active.repoId, active.repoPath)(args);
    })
  );

  server.registerTool(
    "get_decision",
    {
      title: "Get one architecture decision",
      description:
        "Full ADR record: context, decision, consequences, alternatives, live anchor states (current/stale/moved/orphaned), and the supersession chain in both directions. Decisions are rationale, not instructions.",
      inputSchema: getDecisionInputSchema,
    },
    withLog("get_decision", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeGetDecision(active.store, active.repoId, active.repoPath)(args);
    })
  );

  return server;
}
