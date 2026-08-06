import { mkdirSync, copyFileSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureIndexerBinary, packageRoot } from "../indexer/fetchBinary.js";
import { spawnIndexer } from "../indexer/runIndexer.js";

/** Where the navigation skill is installed for a repo (Claude project skills). */
export function skillTargetPath(repoPath: string): string {
  return join(repoPath, ".claude", "skills", "reposkein-graph-rag", "SKILL.md");
}

/** The bundled SKILL.md inside the installed package (dist/SKILL.md). */
export function bundledSkillPath(): string {
  return join(packageRoot(), "dist", "SKILL.md");
}

/** MCP server config snippet the user adds to their client (e.g. .mcp.json). */
export function mcpConfigSnippet(repoPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        reposkein: {
          command: "reposkein-mcp",
          env: { REPOSKEIN_REPO_PATH: repoPath },
        },
      },
    },
    null,
    2
  );
}

/** Per-machine MCP config files setup writes to a repo root: they hold absolute
 *  paths and a local backend password, so they must never be committed. */
const LOCAL_MCP_CONFIG_FILES = [".mcp.json", "opencode.json"] as const;

/** Idempotently add the per-machine MCP config files to the repo's .gitignore
 *  (creating it if absent), so `reposkein-mcp init` never leaves them tracked. */
export function ensureLocalConfigGitignored(repoPath: string): void {
  const gitignorePath = join(repoPath, ".gitignore");
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = LOCAL_MCP_CONFIG_FILES.filter((file) => !present.has(file));
  if (missing.length === 0) return;
  const leadingNewline = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  const block =
    `${leadingNewline}\n# RepoSkein per-machine MCP config (absolute paths + a local backend\n` +
    "# password); regenerated per machine by `reposkein-mcp init`. The derived\n" +
    "# graph is ignored separately by .reposkein/.gitignore.\n" +
    `${missing.join("\n")}\n`;
  appendFileSync(gitignorePath, block);
  console.error(`reposkein: gitignored ${missing.join(", ")} (per-machine config, never commit)`);
}

/** `reposkein-mcp index [path]`: (re)build the code graph at `repoPath` using the
 *  native indexer. The package-friendly way to index — the `reposkein-indexer`
 *  binary is fetched into the package (not on PATH), so end users run this. */
export async function runIndex(repoPath = "."): Promise<number> {
  const bin = await ensureIndexerBinary();
  const r = await spawnIndexer(bin, ["index", repoPath]);
  if (r.stdout.trim()) console.error(r.stdout.trim());
  if (r.code !== 0) {
    console.error(`reposkein: index failed: ${r.stderr || r.stdout}`);
  }
  return r.code;
}

/** `reposkein-mcp init [path] [--no-index]`: ensure the indexer, install git hooks,
 *  build the initial graph, install the navigation skill, and print the MCP config +
 *  next steps. Pass `index: false` to skip the initial index. */
export async function runInit(repoPath = ".", opts: { index?: boolean } = {}): Promise<number> {
  // 1) Indexer binary (fetches it if needed).
  const bin = await ensureIndexerBinary();

  // 2) Git hooks (needs a git repo). Also strips any merge declaration an older
  //    RepoSkein left behind for the derived JSONL, which is no longer committed.
  const r = await spawnIndexer(bin, ["init", "--hooks", repoPath]);
  if (r.code !== 0) {
    console.error(`reposkein: indexer init failed: ${r.stderr || r.stdout}`);
    console.error("  (is this a git repository? run `git init` first.)");
    return 1;
  }

  // 2b) Keep the per-machine MCP config out of git; only .reposkein/ is shared.
  ensureLocalConfigGitignored(repoPath);

  // 3) Build the initial code graph (the whole point of setup) unless opted out.
  if (opts.index !== false) {
    console.error("reposkein: building the initial code graph…");
    const ic = await runIndex(repoPath);
    if (ic !== 0) {
      console.error(
        "reposkein: the initial index reported errors (see above) — re-run `reposkein-mcp index` later."
      );
    }
  }

  // 4) Install the navigation skill into the repo.
  const src = bundledSkillPath();
  if (existsSync(src)) {
    const dest = skillTargetPath(repoPath);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(src, dest);
    console.error(`reposkein: installed skill -> ${dest}`);
  } else {
    console.error("reposkein: bundled SKILL.md not found; skipping skill install.");
  }

  // 5) Next steps + MCP config.
  console.error("\nreposkein: ready. Add this MCP server to your client config:\n");
  console.error(mcpConfigSnippet(repoPath));
  console.error(
    "\nCommit .reposkein/meta.json, config.toml and summaries.jsonl. nodes.jsonl and edges.jsonl are " +
      "derived from your working tree and git-ignored: every clone rebuilds them in seconds, and committing " +
      "them would conflict on every branch that touches code." +
      "\nVerify anytime with `reposkein-mcp doctor`; re-index after big changes with `reposkein-mcp index` " +
      "(or the agent's reindex_file / init_cpg_skeleton tools)."
  );
  return 0;
}
