#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runInit, runIndex } from "./cli/init.js";
import { runDoctor, resolveDoctorRepoPath } from "./cli/doctor.js";
import { runAdr } from "./cli/adr.js";
import { runView, runExport, parseViewArgs } from "./cli/view.js";
import { runStats } from "./cli/stats.js";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Neo4jGraphStore } from "./store/Neo4jGraphStore.js";
import { UnconfiguredStore } from "./store/UnconfiguredStore.js";
import type { GraphStore } from "./store/GraphStore.js";
import { JsonlGraphStore } from "./store/JsonlGraphStore.js";
import { makeReadCypher } from "./tools/readCypher.js";
import type { ToolResult } from "./tools/readCypher.js";
import { makeGetContextProfile } from "./tools/getContextProfile.js";
import { makeWriteSemanticSummary } from "./tools/writeSemanticSummary.js";
import { makeInitCpgSkeleton, makeReindexFile } from "./tools/indexerTools.js";
import { makeSemanticFind } from "./tools/semanticFind.js";
import { makeTemporalContext } from "./tools/temporalContext.js";
import { makeImpact } from "./tools/impact.js";
import { makeRecordDecision } from "./tools/recordDecision.js";
import { makeSetDecisionStatus } from "./tools/setDecisionStatus.js";
import { makeReaffirmDecision } from "./tools/reaffirmDecision.js";
import { makeListDecisions } from "./tools/listDecisions.js";
import { makeGetDecision } from "./tools/getDecision.js";
import { resolveRepoId } from "./store/repoId.js";
import type { RepoResolution } from "./store/resolveRepoPath.js";
import { RepoSession } from "./store/repoSession.js";
import { makeCache } from "./store/repoContextCache.js";
import { ensureGraph } from "./indexer/ensureGraph.js";
import { ensureIndexerBinary, packageVersion } from "./indexer/fetchBinary.js";
import { spawnIndexer } from "./indexer/runIndexer.js";
import { SessionLogger, resolveSessionId } from "./store/sessionLog.js";
import { createToolLogger } from "./store/instrumentTool.js";

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

const HELP_TEXT = `reposkein-mcp — deterministic code-graph MCP server

Usage:
  reposkein-mcp                 start the MCP server (stdio transport)
  reposkein-mcp init [path]     set up a repo (indexer, git hooks, skill, graph)
  reposkein-mcp index [path]    (re)build the committed graph
  reposkein-mcp doctor [path]   health check (indexer binary, index, repo id)
  reposkein-mcp adr <sub> ...   decision-log utilities
  reposkein-mcp stats [path]    session usage report (calls, tokens saved vs grep)
  reposkein-mcp view [path]     open the constellation viewer (--export <dir> for a static site)
  reposkein-mcp --help          show this help
  reposkein-mcp --version       print the package version

Repo resolution (used by the server and by [path]-less CLI commands):
  1. an explicit path argument, if given
  2. REPOSKEIN_REPO_PATH, if set
  3. the nearest ancestor of the current directory containing .reposkein/
  4. a single .reposkein/ found while scanning subdirectories (2 levels deep,
     skipping node_modules/.git/target/dist/.worktrees/.claude)
  If step 4 finds more than one .reposkein/, resolution fails with an error
  naming the candidates — set REPOSKEIN_REPO_PATH (or pass a path) to pick one.

Docs: https://github.com/reposkein/reposkein/tree/main/mcp#readme`;

/** Structured, actionable message for repo-scoped tool calls when no repo
 *  resolved (see `resolveRepoPath`). Names the discovered candidates when
 *  resolution failed due to workspace-mode ambiguity, and points at
 *  `list_repos` / `select_repo` so the agent can pick one instead of
 *  abandoning the tools. */
// Exported for the regression test below (repoRequiredMessage.test.ts) — it
// must keep pointing agents at list_repos/select_repo, not just the env var.
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

// Exported for the regression test below (repoRequiredMessage.test.ts) — it
// must name the found path and the fix (`reposkein-mcp index`), not repeat
// the generic "no repo found" message: a repo WAS found here, it's just not
// indexed yet (or, if `.reposkein/` isn't actually there, misconfigured).
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

// Exported for the regression test. `hops` MUST stay a bounded integer: a literal union
// (z.union([z.literal(1), z.literal(2)])) serialises to JSON-Schema `anyOf:[{const:1},{const:2}]`,
// which Gemini's tool-schema validator 400-rejects — and one bad tool declaration fails the
// whole request, breaking every Gemini model whenever a reposkein tool is in the payload.
export const getContextProfileInputSchema = {
  node_id: z.string().optional(),
  file_path: z.string().optional(),
  name: z.string().optional(),
  hops: z.number().int().min(1).max(2).optional(),
  federated: z.boolean().optional(),
};

// Exported for the schema regression test (no anyOf/oneOf — see the hops note
// above; z.enum serialises to a plain `enum`, which every provider accepts).
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

export async function main(): Promise<void> {
  // Zero-config repo resolution: explicit arg (n/a here) > REPOSKEIN_REPO_PATH >
  // walk-up (nearest ancestor with .reposkein/) > walk-down (workspace mode).
  // See store/resolveRepoPath.ts for the full precedence + ambiguity rules.
  // Session-scoped resolution: `select_repo` (below) can override this for
  // the rest of the connection. Precedence: select_repo > REPOSKEIN_REPO_PATH
  // > walk-up > walk-down. See store/repoSession.ts.
  const session = new RepoSession({
    cwd: process.cwd(),
    envRepoPath: process.env.REPOSKEIN_REPO_PATH,
  });

  // REP-20 session usage stats: one instrumentation point for every tool
  // call, wrapping the handler passed to `server.registerTool` below (each
  // call site does `withLog("tool_name", async (args) => {...})` — logging
  // logic itself lives only in instrumentTool.ts/sessionLog.ts, never in a
  // handler body). Session id = this process's lifetime (start-timestamp +
  // pid), overridable via REPOSKEIN_SESSION_ID for reproducible tests/tooling.
  // `cachedResolve` (used by `resolveActiveRepo` below, and by the two
  // handlers that gate on repoPath alone) memoizes `session.resolve()` per
  // call, so the handler's own resolution and the logger's are the same
  // filesystem walk, not two — see instrumentTool.ts for why and how.
  const sessionLogger = new SessionLogger(resolveSessionId(process.env));
  const { withLog, cachedResolve } = createToolLogger(session, sessionLogger);

  // Per-repoPath {repoId, store} cache. Constructing a JsonlGraphStore is
  // cheap (it lazily loads/re-parses its graph per call, keyed by file
  // mtime) but re-running resolveRepoId/ensureGraph/buildStore on every tool
  // call would still be wasted work for the common single-repo case, and
  // rebuilding the store object would also throw away that per-instance
  // mtime cache — so one context is built per repoPath and reused, letting
  // `select_repo` switch back and forth cheaply too.
  //
  // Only a SUCCESSFUL resolution (repoId defined) is cached — see
  // store/repoContextCache.ts. A repo whose `.reposkein/` exists but isn't
  // indexed yet (no meta.json) is a transient, fixable state: an agent might
  // run `reposkein-mcp index` (or init_cpg_skeleton) out-of-band and expect
  // the very next call in this same session to pick it up. Caching that
  // failure would freeze the session on a stale "not found" forever,
  // undercutting select_repo's whole no-restart-needed point.
  const getRepoContext = makeCache(
    async (path: string): Promise<{ repoId: string | undefined; store: GraphStore }> => {
      const id = resolveRepoId(path, process.env.REPOSKEIN_REPO_ID);
      // Build the graph if the repo has none yet. Derived JSONL is
      // git-ignored, so a fresh clone arrives without it; without this the
      // first query on a newly selected repo would fail on one that indexes
      // fine in seconds.
      await ensureGraph(path, id, {
        mode: (process.env.REPOSKEIN_STORE ?? "auto").toLowerCase(),
        neo4jConfigured: !!process.env.NEO4J_PASSWORD,
      });
      return { repoId: id, store: buildStore(path, id) };
    },
    (ctx) => !!ctx.repoId
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
    // Distinct from repoRequiredMessage: a repo path WAS resolved here — the
    // problem is it isn't indexed (or doesn't actually have .reposkein/),
    // not that none could be found at all. See repoUnindexedMessage.
    if (!ctx.repoId) return { ok: false, message: repoUnindexedMessage(resolution.repoPath) };
    return { ok: true, repoPath: resolution.repoPath, repoId: ctx.repoId, store: ctx.store };
  }
  const errResult = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

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
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, selected: result.repo }) }] };
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
      // read_cypher tolerates an unresolved repo (falls back to whatever
      // buildStore(undefined, undefined) picks — Neo4j if configured, else
      // UnconfiguredStore — matching its pre-existing, non-gated behavior).
      const resolution = cachedResolve();
      const ctx = resolution.repoPath
        ? await getRepoContext(resolution.repoPath)
        : { repoId: undefined, store: buildStore(undefined, undefined) };
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
      description:
        "Attach a 1-3 sentence plain-text business-logic summary to a node, stamped with its current content hash for staleness tracking. Plain text only (no markdown links or code fences), max 1000 chars.",
      inputSchema: {
        node_id: z.string(),
        summary: z.string(),
        model: z.string().optional(),
      },
    },
    withLog("write_semantic_summary", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeWriteSemanticSummary(active.store, active.repoId)(args);
    })
  );

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
    withLog("init_cpg_skeleton", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      // repoPath is threaded through explicitly (see indexerTools.ts) so this
      // always targets the resolved active repo, not a cwd/env-based guess —
      // an explicit args.path still wins inside makeInitCpgSkeleton itself.
      return makeInitCpgSkeleton(active.repoId, active.repoPath)(args);
    })
  );

  server.registerTool(
    "reindex_file",
    {
      title: "Reindex after editing",
      description:
        "Refresh the graph after editing a source file (pass its path). v1 performs a full reindex.",
      inputSchema: { path: z.string() },
    },
    withLog("reindex_file", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      // repoPath threaded explicitly — reindex_file has no path override of
      // its own, so without this it would silently reindex whatever
      // REPOSKEIN_REPO_PATH/cwd points at instead of the selected repo.
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
      return makeSemanticFind(active.store, active.repoId, active.repoPath, undefined, { decisions: true })(args);
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
      // Gated on repoPath only (not repoId/store) — it reads from .git directly.
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

  // Decision tools are gated on repoPath + repoId: records live as committed
  // files under <repoPath>/.reposkein/decisions/, the graph is used only for
  // anchor resolution and hash stamping (Phase 1 — no GraphStore changes).
  // `resolveActiveRepo` already requires both, so it doubles as the gate.
  server.registerTool(
    "record_decision",
    {
      title: "Record an architecture decision",
      description:
        "Record an Architecture Decision Record (ADR): why a significant design choice was made, anchored to the graph nodes and paths it governs. Use for decisions that affect structure, dependencies, interfaces, or construction techniques — not renames, formatting, or routine fixes. Records land as status \"proposed\" (the user ratifies via set_decision_status); pass supersedes to replace an earlier decision. Plain text only; anchors are stamped with the current content hash for drift tracking.",
      inputSchema: recordDecisionInputSchema,
    },
    withLog("record_decision", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      // Best-effort reindex before stamping anchors so a decision recorded
      // right after an edit reflects the working tree, not the last index.
      const decisionRefresh = async (): Promise<void> => {
        const bin = await ensureIndexerBinary();
        await spawnIndexer(bin, ["index", "--json", "--repo-id", active.repoId, active.repoPath]);
      };
      return makeRecordDecision(active.store, active.repoId, active.repoPath, { refresh: decisionRefresh })(args);
    })
  );

  server.registerTool(
    "set_decision_status",
    {
      title: "Set decision status",
      description:
        "Change an ADR's lifecycle status. Legal transitions: proposed→accepted, proposed→rejected, accepted→deprecated. \"superseded\" only happens via record_decision's supersedes. Only ratify to accepted when the user has confirmed the decision.",
      inputSchema: setDecisionStatusInputSchema,
    },
    withLog("set_decision_status", async (args) => {
      const active = await resolveActiveRepo();
      if (!active.ok) return errResult(active.message);
      return makeSetDecisionStatus(active.repoPath)(args);
    })
  );

  server.registerTool(
    "reaffirm_decision",
    {
      title: "Reaffirm a decision",
      description:
        "Mark an ADR as still correct after the code under it changed: re-stamps every anchor from the live graph (stale anchors get the current hash, moved anchors are rebound), clearing review flags without superseding. Use after verifying the changed code still conforms to the decision.",
      inputSchema: reaffirmDecisionInputSchema,
    },
    withLog("reaffirm_decision", async (args) => {
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

  // No passive startup warning here: an unresolved (or ambiguous) repo is
  // surfaced per-call, as a structured, actionable tool error pointing at
  // list_repos/select_repo (repoRequiredMessage above) — not a stderr line
  // an agent can miss and route around by grepping the repo.

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run when invoked as the binary (not when imported by tests). Global installs
// expose the bin via a SYMLINK (e.g. /usr/bin/reposkein-mcp), so argv[1] (the
// symlink) won't equal import.meta.url (the resolved module path) unless we
// realpath it first — otherwise `main()` never runs and the server exits
// immediately (mcp-proxy then reports "Connection closed").
function invokedAsBin(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
if (invokedAsBin()) {
  const sub = process.argv[2];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    // No repo resolution, no config warnings — just usage, per requirement #3.
    console.log(HELP_TEXT);
    process.exit(0);
  } else if (sub === "--version" || sub === "-v") {
    console.log(packageVersion());
    process.exit(0);
  } else if (sub === "init") {
    const rest = process.argv.slice(3);
    const noIndex = rest.includes("--no-index");
    const ci = rest.includes("--ci");
    const path = rest.find((a) => !a.startsWith("-")) ?? ".";
    runInit(path, { index: !noIndex, ci })
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else if (sub === "index") {
    const path = process.argv.slice(3).find((a) => !a.startsWith("-")) ?? process.env.REPOSKEIN_REPO_PATH ?? ".";
    runIndex(path)
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else if (sub === "doctor") {
    const rest = process.argv.slice(3);
    const json = rest.includes("--json");
    const explicitPath = rest.find((a) => !a.startsWith("-"));
    const { path, error } = resolveDoctorRepoPath(explicitPath, process.cwd(), process.env.REPOSKEIN_REPO_PATH);
    if (error) {
      console.error(`reposkein doctor: ${error}`);
      process.exit(1);
    }
    runDoctor(path, json)
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else if (sub === "stats") {
    process.exit(runStats(process.argv.slice(3), process.cwd(), process.env.REPOSKEIN_REPO_PATH));
  } else if (sub === "adr") {
    const rest = process.argv.slice(3);
    const adrSub = rest[0];
    const positional = rest.slice(1).filter((a) => !a.startsWith("-"));
    const path = positional[0] ?? process.env.REPOSKEIN_REPO_PATH ?? ".";
    const dir = positional[1];
    process.exit(runAdr(adrSub, path, dir));
  } else if (sub === "view") {
    const { repoPath, opts, exportDir, exportOpts } = parseViewArgs(process.argv.slice(3));
    const resolvedViewRepoId = resolveRepoId(repoPath, process.env.REPOSKEIN_REPO_ID);
    if (!resolvedViewRepoId) {
      console.error(`reposkein view: could not resolve repo id (no meta.json / REPOSKEIN_REPO_ID); falling back to placeholder "repo"`);
    }
    const vRepoId = resolvedViewRepoId ?? "repo";
    const run = exportDir
      ? runExport(repoPath, vRepoId, exportDir, exportOpts)
      : runView(repoPath, vRepoId, opts);
    run
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else {
    main().catch((err) => { console.error(err); process.exit(1); });
  }
}
