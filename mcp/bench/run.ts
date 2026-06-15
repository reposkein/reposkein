/* Retrieval-efficiency benchmark: RepoSkein structural retrieval vs a grep agent.
 * Deterministic, no LLM/API. Measures precision/recall/F0.5 vs hand-labeled
 * ground-truth + context-token bytes. Run: `npm run bench -- [repoPath]`.
 * Requires ripgrep (`rg`) and the target repo indexed (.reposkein/ present). */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { JsonlGraphStore } from "../src/store/JsonlGraphStore.js";
import { resolveTarget } from "../src/profile/resolve.js";
import { assembleProfile } from "../src/profile/assemble.js";
import { resolveRepoId } from "../src/store/repoId.js";
import { parseNodes, type ParsedNode } from "../src/store/jsonlGraph.js";

interface Task {
  id: string;
  kind: "callers" | "callees" | "lookup";
  question: string;
  seed: string;
  grep_query: string;
  relevant: string[];
}

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve the real ripgrep binary path (not a shell function wrapper).
 *  Tries known locations first, then falls back to `which rg` via a login shell. */
function resolveRgBin(): string {
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back: resolve via shell (handles $PATH customisations)
  const r = spawnSync("/bin/sh", ["-c", "command -v rg"], { encoding: "utf8" });
  const p = r.stdout?.trim();
  if (p && existsSync(p)) return p;
  console.error("bench: ripgrep (`rg`) not found — install it (e.g. `brew install ripgrep`).");
  process.exit(2);
}

const RG_BIN = resolveRgBin();
const repoPath = process.argv[2] ?? join(here, "..", "..");
const repoId = resolveRepoId(repoPath, process.env.REPOSKEIN_REPO_ID);
const nodesFile = join(repoPath, ".reposkein", "nodes.jsonl");
if (!repoId || !existsSync(nodesFile)) {
  console.error(`bench: ${repoPath} is not indexed (no .reposkein/nodes.jsonl) — run \`reposkein-indexer index ${repoPath}\` first.`);
  process.exit(2);
}

// Parsed function nodes (for grep line->function mapping + name->id resolution).
const fnNodes: ParsedNode[] = parseNodes(readFileSync(nodesFile, "utf8"), repoId).filter((n) =>
  n.labels.includes("Function")
);
const idsByName = new Map<string, string[]>();
for (const n of fnNodes) {
  const nm = typeof n.props.name === "string" ? n.props.name : null;
  if (nm) (idsByName.get(nm) ?? idsByName.set(nm, []).get(nm)!).push(n.id);
}
const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** Function node whose file_path == file and start_line <= line <= end_line. */
function enclosingFn(file: string, line: number): string | null {
  let best: { id: string; span: number } | null = null;
  for (const n of fnNodes) {
    if (n.props.file_path !== file) continue;
    const s = num(n.props.start_line);
    const e = num(n.props.end_line);
    if (s <= line && line <= e) {
      const span = e - s;
      if (!best || span < best.span) best = { id: n.id, span }; // tightest enclosing
    }
  }
  return best?.id ?? null;
}

function namesToIds(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const nm of names) for (const id of idsByName.get(nm) ?? []) out.add(id);
  return out;
}

function prf(retrieved: Set<string>, relevant: Set<string>) {
  let tp = 0;
  for (const id of retrieved) if (relevant.has(id)) tp++;
  const precision = retrieved.size ? tp / retrieved.size : relevant.size === 0 ? 1 : 0;
  const recall = relevant.size ? tp / relevant.size : 1;
  const beta2 = 0.25; // F-beta, beta=0.5 (precision-weighted, per Cognition)
  const denom = beta2 * precision + recall;
  const f = denom ? ((1 + beta2) * precision * recall) / denom : 0;
  return { precision, recall, f };
}

const est = (s: string) => Math.ceil(s.length / 4); // crude token estimate

const store = new JsonlGraphStore(repoPath, repoId);

interface ArmResult {
  retrieved: Set<string>;
  bytes: number;
}

async function reposkeinArm(t: Task): Promise<ArmResult> {
  const r = await resolveTarget(store, [repoId!], { name: t.seed });
  if (r.kind !== "found") return { retrieved: new Set(), bytes: 0 };
  if (t.kind === "lookup") {
    // Cost = the resolved target row serialized; retrieved = the target.
    return { retrieved: new Set([r.target.id]), bytes: JSON.stringify(r.target).length };
  }
  const profile = await assembleProfile(store, [repoId!], r.target, 1);
  const side = t.kind === "callers" ? profile.upstream : profile.downstream;
  // Cost = the profile the agent consumes (inlined_context + neighbor list).
  return { retrieved: new Set(side.map((n) => n.id)), bytes: JSON.stringify(profile).length };
}

function grepArm(t: Task): { retrieved: Set<string>; rgBytes: number; files: Set<string> } {
  let out = "";
  try {
    out = execFileSync(
      RG_BIN,
      ["-n", "--no-heading", "--color=never", "-g", "!.reposkein", "-g", "!target", "-g", "!node_modules", "-g", "!dist", t.grep_query, "."],
      { cwd: repoPath, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e: any) {
    out = typeof e?.stdout === "string" ? e.stdout : ""; // rg exits 1 on no matches
  }
  const retrieved = new Set<string>();
  const files = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(.+?):(\d+):/);
    if (!m) continue;
    const file = m[1]!.replace(/^\.\//, "");
    files.add(file);
    const fn = enclosingFn(file, Number(m[2]));
    if (fn) retrieved.add(fn);
  }
  return { retrieved, rgBytes: out.length, files };
}

/** Grep token cost = rg output + the bytes of source the agent reads.
 *  Two transparent models: read whole matched FILES (upper bound) and read
 *  matched FUNCTION bodies only (lower bound, generous to grep). Headline uses
 *  the generous lower bound so RepoSkein's win can't be inflated. */
function grepBytes(repoRoot: string, g: ReturnType<typeof grepArm>): { readFiles: number; readFns: number } {
  let readFiles = g.rgBytes;
  for (const f of g.files) {
    try { readFiles += readFileSync(join(repoRoot, f), "utf8").length; } catch { /* skip */ }
  }
  let readFns = g.rgBytes;
  for (const id of g.retrieved) {
    const n = fnNodes.find((x) => x.id === id);
    if (!n) continue;
    const file = String(n.props.file_path);
    const s = num(n.props.start_line);
    const e = num(n.props.end_line);
    try {
      const lines = readFileSync(join(repoRoot, file), "utf8").split("\n");
      readFns += lines.slice(Math.max(0, s - 1), e).join("\n").length;
    } catch { /* skip */ }
  }
  return { readFiles, readFns };
}

async function main() {
  const fx = JSON.parse(
    readFileSync(join(here, "fixtures", "reposkein.json"), "utf8")
  ) as { tasks: Task[] };

  const rows: string[] = [];
  let sumRatio = 0;
  let nStruct = 0;
  for (const t of fx.tasks) {
    const relevant = namesToIds(t.relevant);
    const rs = await reposkeinArm(t);
    const g = grepArm(t);
    const gb = grepBytes(repoPath, g);
    const rsScore = prf(rs.retrieved, relevant);
    const gScore = prf(g.retrieved, relevant);
    const rsTok = est(JSON.stringify({})) + Math.ceil(rs.bytes / 4);
    const gTokFns = Math.ceil(gb.readFns / 4);
    const gTokFiles = Math.ceil(gb.readFiles / 4);
    const ratioGenerous = rsTok ? gTokFns / rsTok : 0; // generous-to-grep
    if (t.kind !== "lookup") {
      sumRatio += ratioGenerous;
      nStruct++;
    }
    rows.push(
      `| ${t.id} | ${t.kind} | ${rsScore.f.toFixed(2)} | ${gScore.f.toFixed(2)} | ${rsTok} | ${gTokFns} / ${gTokFiles} | ${ratioGenerous.toFixed(1)}× |`
    );
  }

  console.log(`# RepoSkein retrieval benchmark — ${fx.tasks.length} tasks on ${repoPath}\n`);
  console.log("Token cost = est. tokens (chars/4) of context surfaced. grep = rg output + function-bodies / whole-files read. Ratio = grep(functions, generous) ÷ RepoSkein.\n");
  console.log("| task | kind | RepoSkein F0.5 | grep F0.5 | RepoSkein tok | grep tok (fns/files) | token ratio |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  if (nStruct) console.log(`\n**Mean token ratio on structural tasks: ${(sumRatio / nStruct).toFixed(1)}× (grep ÷ RepoSkein, generous-to-grep).**`);
  console.log("\n_Measures the retrieval layer (no LLM): which functions each strategy surfaces + the context tokens to do so. Not end-task success. RepoSkein's edge is structural/impact queries on non-trivial files; grep is competitive on unique-symbol lookup (the lookup task)._");

  await store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
