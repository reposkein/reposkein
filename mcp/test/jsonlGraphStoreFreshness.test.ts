import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlGraphStore } from "../src/store/JsonlGraphStore.js";
import { sidecarPath } from "../src/store/sidecar.js";

/** Freshness: the derived graph and the authored overlay are separate inputs.
 *
 *  One key used to cover both, so writing a summary — which rewrites the agent
 *  sidecar, changing its mtime and size — invalidated the whole graph and the
 *  next tool call re-parsed nodes.jsonl, edges.jsonl and every shard. The node
 *  had already been updated in place, so the rebuild was pure waste, and a
 *  summarisation loop of K writes cost K full reloads.
 *
 *  Observed without reaching inside the store: swap the contents of
 *  nodes.jsonl while preserving its mtime. A re-parse would pick the swap up;
 *  serving the old value proves no re-parse happened. */

const REPO = "freshtest";
const FN = `rs1:${REPO}:func:svc.py#run@0`;

const nodesText = (qualifiedName: string) =>
  [
    `{"id":"rs1:${REPO}:file:svc.py","labels":["File"],"content_hash":"hf","name":"svc.py","path":"svc.py"}`,
    `{"id":"${FN}","labels":["Function"],"content_hash":"hrun","end_line":4,"file_path":"svc.py","name":"run","qualified_name":"${qualifiedName}","start_line":2}`,
  ].join("\n") + "\n";

const EDGES = "";

describe("JsonlGraphStore freshness", () => {
  let root: string;
  let nodesPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-store-fresh-"));
    mkdirSync(join(root, ".reposkein"), { recursive: true });
    nodesPath = join(root, ".reposkein", "nodes.jsonl");
    writeFileSync(nodesPath, nodesText("run"));
    writeFileSync(join(root, ".reposkein", "edges.jsonl"), EDGES);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Rewrite nodes.jsonl but leave its mtime alone — only a re-parse sees this. */
  const swapNodesInvisibly = (qualifiedName: string) => {
    const before = statSync(nodesPath);
    writeFileSync(nodesPath, nodesText(qualifiedName));
    utimesSync(nodesPath, before.atime, before.mtime);
  };

  const writeSidecar = (agent: string, summary: string) => {
    mkdirSync(join(root, ".reposkein", "local"), { recursive: true });
    writeFileSync(
      sidecarPath(root, agent),
      `{"id":"${FN}","semantic_summary":"${summary}","summary_at":"2026-08-20","summary_by":"${agent}","summary_model":"m","summary_of_hash":"hrun"}\n`
    );
  };

  const node = async (store: JsonlGraphStore) => await store.getNode([REPO], FN);

  it("applies a new summary without re-parsing the derived graph", async () => {
    const store = new JsonlGraphStore(root, REPO);
    expect((await node(store))?.qualified_name).toBe("run");

    swapNodesInvisibly("run_REPARSED");
    writeSidecar("agent-a", "runs the thing");

    const after = await node(store);
    expect(after?.semantic_summary).toBe("runs the thing"); // overlay re-applied
    expect(after?.qualified_name).toBe("run"); // graph NOT re-parsed
  });

  it("still re-parses when the derived graph itself changes", async () => {
    const store = new JsonlGraphStore(root, REPO);
    expect((await node(store))?.qualified_name).toBe("run");

    // A real index run: new content AND a new mtime.
    writeFileSync(nodesPath, nodesText("run_REINDEXED"));
    const now = new Date(Date.now() + 2000);
    utimesSync(nodesPath, now, now);

    expect((await node(store))?.qualified_name).toBe("run_REINDEXED");
  });

  it("drops a summary again when its sidecar goes away", async () => {
    // Re-applying an overlay onto an already-overlaid graph must not leave the
    // previous overlay's props behind.
    const store = new JsonlGraphStore(root, REPO);
    writeSidecar("agent-a", "runs the thing");
    expect((await node(store))?.semantic_summary).toBe("runs the thing");

    unlinkSync(sidecarPath(root, "agent-a"));

    const after = await node(store);
    expect(after?.semantic_summary ?? null).toBeNull();
    expect(after?.qualified_name).toBe("run");
  });

  it("replaces a summary rather than merging it when the overlay changes", async () => {
    const store = new JsonlGraphStore(root, REPO);
    writeSidecar("agent-a", "first take");
    expect((await node(store))?.semantic_summary).toBe("first take");

    writeSidecar("agent-a", "second take");
    expect((await node(store))?.semantic_summary).toBe("second take");
  });

  it("serves repeated reads with no overlay change consistently", async () => {
    const store = new JsonlGraphStore(root, REPO);
    writeSidecar("agent-a", "runs the thing");
    expect((await node(store))?.semantic_summary).toBe("runs the thing");
    expect((await node(store))?.semantic_summary).toBe("runs the thing");
    expect((await node(store))?.qualified_name).toBe("run");
  });
});
