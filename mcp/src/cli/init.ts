import { mkdirSync, copyFileSync, existsSync } from "node:fs";
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

/** `reposkein-mcp init [path]`: ensure the indexer, install hooks + merge driver,
 *  install the navigation skill, and print the MCP config + next steps. */
export async function runInit(repoPath = "."): Promise<number> {
  // 1) Indexer binary (fetches it if needed).
  const bin = await ensureIndexerBinary();

  // 2) Git hooks + JSONL merge driver (needs a git repo).
  const r = await spawnIndexer(bin, ["init", "--hooks", repoPath]);
  if (r.code !== 0) {
    console.error(`reposkein: indexer init failed: ${r.stderr || r.stdout}`);
    console.error("  (is this a git repository? run `git init` first.)");
    return 1;
  }

  // 3) Install the navigation skill into the repo.
  const src = bundledSkillPath();
  if (existsSync(src)) {
    const dest = skillTargetPath(repoPath);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(src, dest);
    console.error(`reposkein: installed skill -> ${dest}`);
  } else {
    console.error("reposkein: bundled SKILL.md not found; skipping skill install.");
  }

  // 4) Next steps + MCP config.
  console.error("\nreposkein: ready. Add this MCP server to your client config:\n");
  console.error(mcpConfigSnippet(repoPath));
  console.error(
    "\nThen ask your agent to build the graph (the `init_cpg_skeleton` tool), " +
      "or run `reposkein-indexer index` here. Commit the generated .reposkein/ dir."
  );
  return 0;
}
