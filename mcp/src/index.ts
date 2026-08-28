#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runInit, runIndex } from "./cli/init.js";
import { parseAgentsFlag } from "./cli/agentAdapters.js";
import { runDoctor, resolveDoctorRepoPath } from "./cli/doctor.js";
import { runMigrate } from "./cli/migrate.js";
import { runAdr } from "./cli/adr.js";
import { runAdrReanchor } from "./cli/adrReanchor.js";
import { runView, runExport, parseViewArgs } from "./cli/view.js";
import { runStats } from "./cli/stats.js";
import { runSupport } from "./cli/support.js";
import { runServe, parseServeArgs } from "./serve/serve.js";
import { realpathSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveRepoId } from "./store/repoId.js";
import { createMcpServer } from "./server/createMcpServer.js";
import { packageVersion } from "./indexer/fetchBinary.js";

/** Re-exported from `server/createMcpServer.ts`, where the tool registration
 *  now lives (REP-17 extracted it so `serve --http` can build one server PER
 *  CONNECTION). Kept here because these are this module's public surface. */
export {
  repoRequiredMessage,
  repoUnindexedMessage,
  getContextProfileInputSchema,
  recordDecisionInputSchema,
  setDecisionStatusInputSchema,
  reaffirmDecisionInputSchema,
  reanchorDecisionInputSchema,
  listDecisionsInputSchema,
  getDecisionInputSchema,
  createMcpServer,
  buildStore,
  WRITE_TOOLS,
} from "./server/createMcpServer.js";

const HELP_TEXT = `reposkein-mcp — deterministic code-graph MCP server

Usage:
  reposkein-mcp                 start the MCP server (stdio transport)
  reposkein-mcp init [path]     set up a repo (indexer, git hooks, skill, graph); --no-index skips the initial index, --ci also writes a GitHub Pages publish workflow (see docs/HOSTING.md). On a repo joined from a committed .reposkein/meta.json, also auto-writes local agent MCP config (--agents claude,opencode,cursor to override detection, --dry-run to preview)
  reposkein-mcp index [path]    (re)build the committed graph
  reposkein-mcp doctor [path]   health check (indexer binary, index, repo id, hooks, graph freshness); --json for machine output, --ci additionally fails on stale graph / missing hooks / unsplit legacy summaries
  reposkein-mcp migrate [path] [--dry-run]  untrack a still-committed derived graph (pre-0.2.7 repos), refresh hooks + .gitignore/.gitattributes
  reposkein-mcp adr <sub> ...   decision-log utilities (export|import|reanchor)
  reposkein-mcp stats [path]    session usage report (calls, tokens saved vs grep)
  reposkein-mcp support <token> install a supporter token (verified locally, stored at ~/.config/reposkein/supporter.jwt, mode 600); pass \`-\` to read it from stdin instead of argv (keeps it out of shell history and \`ps\`); --status to show tier/expiry, --remove to delete it. Offline: no network call, ever
  reposkein-mcp view [path]     open the constellation viewer (--export <dir> for a static site)
  reposkein-mcp serve --http    ADVANCED, OPTIONAL: shared remote server — MCP over Streamable HTTP + the viewer/API in one process, bearer-token auth, read-only by default (see docs/REMOTE.md)
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

/** Starts the MCP server on the stdio transport — the default and only
 *  transport for a single developer. One `createMcpServer` per process, with
 *  full write capability and the historical REPOSKEIN_AGENT identity
 *  fallback: unchanged by REP-17. */
export async function main(): Promise<void> {
  const server = createMcpServer({
    cwd: process.cwd(),
    envRepoPath: process.env.REPOSKEIN_REPO_PATH,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** True when this module is the process entry point (`reposkein-mcp`), false
 *  when it's imported (tests, other tools) — so importing never starts a
 *  server or parses argv. */
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
    console.log(HELP_TEXT);
    process.exit(0);
  } else if (sub === "--version" || sub === "-v") {
    console.log(packageVersion());
    process.exit(0);
  } else if (sub === "init") {
    const rest = process.argv.slice(3);
    const noIndex = rest.includes("--no-index");
    const ci = rest.includes("--ci");
    const dryRun = rest.includes("--dry-run");
    const agentsIdx = rest.indexOf("--agents");
    const agents = agentsIdx !== -1 ? parseAgentsFlag(rest[agentsIdx + 1] ?? "") : undefined;
    const path = rest.find((a, i) => !a.startsWith("-") && rest[i - 1] !== "--agents") ?? ".";
    runInit(path, { index: !noIndex, ci, dryRun, agents })
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
    const ci = rest.includes("--ci");
    const explicitPath = rest.find((a) => !a.startsWith("-"));
    const { path, error } = resolveDoctorRepoPath(explicitPath, process.cwd(), process.env.REPOSKEIN_REPO_PATH);
    if (error) {
      console.error(`reposkein doctor: ${error}`);
      process.exit(1);
    }
    runDoctor(path, { json, ci })
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else if (sub === "migrate") {
    const rest = process.argv.slice(3);
    const dryRun = rest.includes("--dry-run");
    const path = rest.find((a) => !a.startsWith("-")) ?? process.env.REPOSKEIN_REPO_PATH ?? ".";
    runMigrate(path, { dryRun })
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else if (sub === "stats") {
    process.exit(runStats(process.argv.slice(3), process.cwd(), process.env.REPOSKEIN_REPO_PATH));
  } else if (sub === "support") {
    // No repo resolution: entitlement is a property of the user, not of a
    // checkout, so this subcommand works anywhere — including outside a repo.
    process.exit(runSupport(process.argv.slice(3)));
  } else if (sub === "adr") {
    const rest = process.argv.slice(3);
    const adrSub = rest[0];
    if (adrSub === "reanchor") {
      runAdrReanchor(rest.slice(1), process.env.REPOSKEIN_REPO_PATH)
        .then((code) => process.exit(code))
        .catch((err) => { console.error(err); process.exit(2); });
    } else {
      const positional = rest.slice(1).filter((a) => !a.startsWith("-"));
      const path = positional[0] ?? process.env.REPOSKEIN_REPO_PATH ?? ".";
      const dir = positional[1];
      process.exit(runAdr(adrSub, path, dir));
    }
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
  } else if (sub === "serve") {
    // OPTIONAL remote mode (REP-17). `--http` is required and explicit: no
    // subcommand of this CLI opens a socket by accident.
    const { repoPath, opts, http } = parseServeArgs(process.argv.slice(3));
    if (!http) {
      console.error(
        "reposkein serve: --http is required (it is the only transport this subcommand serves).\n" +
          "  Usage: reposkein-mcp serve --http [path] [--port N] [--host H] [--watch-interval SECONDS]\n" +
          "  This is an advanced, optional deployment — see docs/REMOTE.md. For normal use, run\n" +
          "  `reposkein-mcp` with no subcommand (stdio)."
      );
      process.exit(1);
    }
    const serveRepoId = resolveRepoId(repoPath, process.env.REPOSKEIN_REPO_ID);
    if (!serveRepoId) {
      console.error(
        `reposkein serve: could not resolve a repo id for ${repoPath} (no .reposkein/meta.json, no REPOSKEIN_REPO_ID).\n` +
          "  Run `reposkein-mcp init` there first."
      );
      process.exit(1);
    }
    runServe(repoPath, serveRepoId, opts)
      .then((code) => process.exit(code))
      .catch((err) => { console.error(err); process.exit(1); });
  } else {
    main().catch((err) => { console.error(err); process.exit(1); });
  }
}
