import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlGraphStore } from "../src/store/JsonlGraphStore.js";
import { sidecarPath } from "../src/store/sidecar.js";
import { conflictsPath, summariesDir } from "../src/store/summaryShards.js";

/** The store's summary overlay, end to end over a real `.reposkein/` on disk.
 *
 *  Every piece of this was unit-tested in isolation and none of it was tested
 *  wired together, which is where a read path actually breaks: the shard
 *  loader could be perfect and the store could still never call it, gate on the
 *  wrong field, or never notice a `git pull`. */

const REPO = "shardtest";
const FN = `rs1:${REPO}:func:svc.py#run@0`;
const OTHER = `rs1:${REPO}:func:svc.py#other@0`;

const NODES =
  [
    `{"id":"rs1:${REPO}:file:svc.py","labels":["File"],"content_hash":"hf","name":"svc.py","path":"svc.py"}`,
    `{"id":"${FN}","labels":["Function"],"content_hash":"hrun","end_line":4,"file_path":"svc.py","name":"run","qualified_name":"run","start_line":2}`,
    `{"id":"${OTHER}","labels":["Function"],"content_hash":"hother","end_line":9,"file_path":"svc.py","name":"other","qualified_name":"other","start_line":7}`,
  ].join("\n") + "\n";

const EDGES = `{"from":"${FN}","type":"CALLS","to":"${OTHER}","call_sites":1,"confidence":1.0,"resolution":"exact"}\n`;

describe("JsonlGraphStore summary overlay", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-store-shards-"));
    mkdirSync(join(root, ".reposkein"), { recursive: true });
    writeFileSync(join(root, ".reposkein", "nodes.jsonl"), NODES);
    writeFileSync(join(root, ".reposkein", "edges.jsonl"), EDGES);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const shard = (name: string, ...lines: string[]) => {
    mkdirSync(summariesDir(root), { recursive: true });
    writeFileSync(join(summariesDir(root), name), lines.map((l) => `${l}\n`).join(""));
  };
  const sidecar = (agent: string, ...lines: string[]) => {
    mkdirSync(join(root, ".reposkein", "local"), { recursive: true });
    writeFileSync(sidecarPath(root, agent), lines.map((l) => `${l}\n`).join(""));
  };
  const line = (id: string, summary: string, hash: string, at = "2026-08-20") =>
    `{"id":"${id}","semantic_summary":"${summary}","summary_at":"${at}","summary_by":"agent","summary_model":"m","summary_of_hash":"${hash}"}`;

  const summaryOf = async (store: JsonlGraphStore, id: string) =>
    (await store.getNode([REPO], id))?.semantic_summary ?? null;

  it("serves a summary that exists only in a committed shard", async () => {
    // The ordinary case after `git pull`: the teammate's shard is committed,
    // the derived graph is not, so nothing but this overlay can surface it.
    shard("00.jsonl", line(FN, "runs the thing", "hrun"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("runs the thing");
  });

  it("reads every shard, not just the first", async () => {
    shard("00.jsonl", line(FN, "runs the thing", "hrun"));
    shard("f3.jsonl", line(OTHER, "the other thing", "hother"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("runs the thing");
    expect(await summaryOf(store, OTHER)).toBe("the other thing");
  });

  it("withholds a summary whose content hash no longer matches the node", async () => {
    // The gate that keeps stale prose from reading as current. A summary
    // stamped against code that has since changed is stale, not wrong — the
    // shard keeps it, but the graph must not serve it.
    shard("00.jsonl", line(FN, "describes the OLD body", "hstale"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBeNull();
  });

  it("still serves the fresh ones when a sibling record is stale", async () => {
    shard("00.jsonl", line(FN, "stale", "hstale"), line(OTHER, "fresh", "hother"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBeNull();
    expect(await summaryOf(store, OTHER)).toBe("fresh");
  });

  it("ignores a shard record for a node that no longer exists", async () => {
    shard("00.jsonl", line(`rs1:${REPO}:func:deleted.py#gone@0`, "about deleted code", "hx"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await store.getNode([REPO], `rs1:${REPO}:func:deleted.py#gone@0`)).toBeNull();
  });

  it("lets a sidecar supersede the committed shard for the same node", async () => {
    shard("00.jsonl", line(FN, "committed version", "hrun", "2026-08-20"));
    sidecar("claude", line(FN, "rewritten locally", "hrun", "2026-08-21"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("rewritten locally");
  });

  it("does not let a STALE sidecar clobber a newer committed summary", async () => {
    // The cross-source rule, on the read path: what the server serves must be
    // what the next `index` will write, or the agent reads prose that is about
    // to vanish.
    shard("00.jsonl", line(FN, "teammate newer", "hrun", "2026-09-01"));
    sidecar("claude", line(FN, "stale local", "hrun", "2026-01-01"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("teammate newer");
  });

  it("records divergence losers from a merged shard to local/conflicts.jsonl", async () => {
    shard(
      "00.jsonl",
      line(FN, "ours", "hrun", "2026-08-19"),
      line(FN, "theirs", "hrun", "2026-08-20")
    );

    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("theirs");

    expect(existsSync(conflictsPath(root))).toBe(true);
    expect(readFileSync(conflictsPath(root), "utf8")).toContain("ours");
  });

  it("records a loser displaced across sources, not just within one shard", async () => {
    shard("00.jsonl", line(FN, "committed", "hrun", "2026-01-01"));
    sidecar("claude", line(FN, "local rewrite", "hrun", "2026-09-01"));

    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("local rewrite");
    expect(readFileSync(conflictsPath(root), "utf8")).toContain("committed");
  });

  it("writes no conflicts file when nothing diverged", async () => {
    shard("00.jsonl", line(FN, "the only one", "hrun"));
    const store = new JsonlGraphStore(root, REPO);
    await summaryOf(store, FN);
    expect(existsSync(conflictsPath(root))).toBe(false);
  });

  it("picks up shards that appear after the store was constructed", async () => {
    // A `git pull` brings in a teammate's shard while the server is running.
    // Keying freshness on nodes/edges alone made this invisible for the life of
    // the process — and those two files are git-ignored, so they do NOT change
    // on a pull. This is the ordinary case, not an edge case.
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBeNull();

    shard("00.jsonl", line(FN, "arrived with a pull", "hrun"));

    expect(await summaryOf(store, FN)).toBe("arrived with a pull");
  });

  it("picks up a shard whose contents changed in place", async () => {
    shard("00.jsonl", line(FN, "first", "hrun", "2026-08-20"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("first");

    shard("00.jsonl", line(FN, "second", "hrun", "2026-09-01"));
    expect(await summaryOf(store, FN)).toBe("second");
  });

  it("notices a shard that was deleted", async () => {
    shard("00.jsonl", line(FN, "here for now", "hrun"));
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("here for now");

    rmSync(summariesDir(root), { recursive: true, force: true });
    expect(await summaryOf(store, FN)).toBeNull();
  });

  it("sees another agent's sidecar write on an already-open store", async () => {
    // Two agents, one checkout, one live server each. Agent B writes; agent A's
    // store must see it on its next access. The freshness key used to cover
    // only nodes/edges and the shards, so B's write was invisible for the life
    // of A's process — while the overlay's own comment promised the opposite.
    const storeA = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(storeA, FN)).toBeNull();

    sidecar("agent-b", line(FN, "written by agent B", "hrun", "2026-08-21"));

    expect(await summaryOf(storeA, FN)).toBe("written by agent B");
  });

  it("sees another agent OVERWRITING a summary this store already served", async () => {
    sidecar("agent-b", line(FN, "B's first take", "hrun", "2026-08-21"));
    const storeA = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(storeA, FN)).toBe("B's first take");

    sidecar("agent-b", line(FN, "B's revision", "hrun", "2026-08-22"));

    expect(await summaryOf(storeA, FN)).toBe("B's revision");
  });

  it("sees a sidecar that was removed (consumed by an index)", async () => {
    sidecar("agent-b", line(FN, "pending", "hrun", "2026-08-21"));
    const storeA = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(storeA, FN)).toBe("pending");

    // `index` claims the sidecar by rename and folds it into a shard.
    rmSync(sidecarPath(root, "agent-b"));
    shard("00.jsonl", line(FN, "pending", "hrun", "2026-08-21"));

    expect(await summaryOf(storeA, FN)).toBe("pending");
  });

  it("does not serve a null-valued summary, and does not let it evict prose", async () => {
    // A field that is present but says nothing is not a summary. Rust once
    // tested this with contains_key and TS with typeof === "string", so a
    // null-valued line with a late timestamp won the tiebreak on one side and
    // was skipped on the other.
    shard(
      "00.jsonl",
      line(FN, "real prose", "hrun", "2026-01-01"),
      `{"id":"${FN}","semantic_summary":null,"summary_at":"2099-01-01","summary_of_hash":"hrun"}`
    );
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("real prose");
    // Rejected as malformed, not ranked — so it is not a "conflict" either.
    expect(existsSync(conflictsPath(root))).toBe(false);
  });

  it("survives a shard left with conflict markers", async () => {
    mkdirSync(summariesDir(root), { recursive: true });
    writeFileSync(
      join(summariesDir(root), "00.jsonl"),
      `<<<<<<< HEAD\n${line(FN, "ours", "hrun", "2026-08-21")}\n=======\n${line(OTHER, "theirs", "hother", "2026-08-21")}\n>>>>>>> other\n`
    );
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("ours");
    expect(await summaryOf(store, OTHER)).toBe("theirs");
  });

  it("dual-reads the pre-sharding summaries.jsonl", async () => {
    writeFileSync(
      join(root, ".reposkein", "summaries.jsonl"),
      `${line(FN, "from the old file", "hrun")}\n`
    );
    const store = new JsonlGraphStore(root, REPO);
    expect(await summaryOf(store, FN)).toBe("from the old file");
  });

  it("a write_semantic_summary lands in this agent's sidecar and reads back", async () => {
    const store = new JsonlGraphStore(root, REPO);
    const res = await store.writeSummary(REPO, FN, {
      summary: "written by the tool",
      model: "m",
      at: "2026-08-21",
      by: "agent",
    });
    expect(res.kind).toBe("ok");
    expect(await summaryOf(store, FN)).toBe("written by the tool");
    // A fresh store over the same directory sees it too — it is on disk, not
    // just in the first store's memory.
    expect(await summaryOf(new JsonlGraphStore(root, REPO), FN)).toBe("written by the tool");
  });
});
