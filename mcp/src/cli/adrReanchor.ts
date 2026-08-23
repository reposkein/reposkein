import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildStore } from "../server/createMcpServer.js";
import { anchorRepoIds, loadDecisions } from "../store/decisions.js";
import { resolveRepoId } from "../store/repoId.js";
import { applyReanchor, planReanchor } from "../store/reanchor.js";

/** `reposkein-mcp adr reanchor [path] [--dry-run] [--id <adr-id>]` (REP-24).
 *  Exit codes: 0 = clean (nothing unresolved), 1 = partial (ambiguous or
 *  orphaned anchors remain — reported, never guessed), 2 = usage/environment
 *  error. Deterministic: decisions in id order; the only time field is
 *  reanchored_at, injected via opts for tests. */
export async function runAdrReanchor(
  argv: string[],
  envRepoPath?: string,
  opts: { today?: () => string } = {}
): Promise<number> {
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  const dryRun = argv.includes("--dry-run");
  const idFlag = argv.indexOf("--id");
  const onlyId = idFlag >= 0 ? argv[idFlag + 1] : undefined;
  if (idFlag >= 0 && (!onlyId || onlyId.startsWith("-"))) {
    console.error("adr reanchor: --id requires a decision id");
    return 2;
  }
  const positional = argv.filter((a, i) => !a.startsWith("-") && argv[i - 1] !== "--id");
  const repoPath = positional[0] ?? envRepoPath ?? ".";

  const repoId = resolveRepoId(repoPath, process.env.REPOSKEIN_REPO_ID);
  if (!repoId || !existsSync(join(repoPath, ".reposkein", "nodes.jsonl"))) {
    console.error("adr reanchor: no graph found — run `reposkein-mcp index` first");
    return 2;
  }

  const { decisions, warnings } = loadDecisions(repoPath);
  for (const w of warnings) console.error(`warning: ${w}`);
  const targets = onlyId
    ? decisions.filter((d) => d.id === onlyId)
    : decisions.filter((d) => d.anchors.length > 0);
  if (onlyId && targets.length === 0) {
    console.error(`adr reanchor: unknown decision: ${onlyId}`);
    return 2;
  }

  const store = buildStore(repoPath, repoId);
  try {
    const repoIds = await anchorRepoIds(store, repoId);
    // Hoisted so every decision in this run gets the same stamp — a sweep
    // straddling midnight must not split across two dates.
    const reanchoredAt = today();
    let rebound = 0;
    let unresolved = 0;
    for (const rec of targets) {
      const plan = await planReanchor(store, repoIds, rec);
      for (const a of plan.anchors) {
        if (a.action === "rebind") {
          console.error(`${rec.id}: rebind ${a.anchor.node_id} -> ${a.to!.node_id}`);
          rebound++;
        } else if (a.action === "ambiguous") {
          console.error(
            `${rec.id}: ambiguous ${a.anchor.node_id} (${a.candidates} content-hash matches) — untouched`
          );
        } else if (a.action === "orphaned") {
          console.error(`${rec.id}: orphaned ${a.anchor.node_id} — untouched`);
        } else if (a.action === "stale") {
          console.error(`${rec.id}: stale ${a.anchor.node_id} — content changed; reaffirm or supersede`);
        }
      }
      unresolved += plan.unresolved;
      if (!dryRun) applyReanchor(repoPath, rec, plan, reanchoredAt);
    }
    console.error(
      `${dryRun ? "[dry-run] " : ""}reanchored ${rebound} anchor${rebound === 1 ? "" : "s"} across ${
        targets.length
      } decision${targets.length === 1 ? "" : "s"}` + (unresolved ? `; ${unresolved} unresolved` : "")
    );
    return unresolved > 0 ? 1 : 0;
  } finally {
    await store.close();
  }
}
