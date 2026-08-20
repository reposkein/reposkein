import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSlug,
  loadAllSidecars,
  readAllSidecars,
  readSidecar,
  sidecarPath,
  sidecarPaths,
  upsertSidecar,
} from "../src/store/sidecar.js";

describe("sidecar", () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-sidecar-"));
    path = sidecarPath(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const rec = (id: string, hash: string) => ({
    id,
    semantic_summary: `summary ${id}`,
    summary_of_hash: hash,
    summary_model: "opus",
    summary_at: "2026-06-12",
    summary_by: "agent",
  });

  it("returns an empty map when the file is absent", () => {
    expect(readSidecar(path).size).toBe(0);
  });

  it("upsert creates the file and round-trips a record", () => {
    upsertSidecar(path, rec("rs1:r:func:a#f@0", "h1"));
    expect(existsSync(path)).toBe(true);
    const m = readSidecar(path);
    expect(m.get("rs1:r:func:a#f@0")?.semantic_summary).toBe("summary rs1:r:func:a#f@0");
    expect(m.get("rs1:r:func:a#f@0")?.summary_of_hash).toBe("h1");
  });

  it("upsert dedups by id (no duplicate lines) and keeps the latest", () => {
    upsertSidecar(path, rec("rs1:r:func:a#f@0", "h1"));
    upsertSidecar(path, { ...rec("rs1:r:func:a#f@0", "h2"), semantic_summary: "updated" });
    const m = readSidecar(path);
    expect(m.size).toBe(1);
    expect(m.get("rs1:r:func:a#f@0")?.semantic_summary).toBe("updated");
    expect(m.get("rs1:r:func:a#f@0")?.summary_of_hash).toBe("h2");
  });

  it("upsert keeps multiple distinct ids sorted", () => {
    upsertSidecar(path, rec("rs1:r:func:b#g@0", "h2"));
    upsertSidecar(path, rec("rs1:r:func:a#f@0", "h1"));
    const m = readSidecar(path);
    expect([...m.keys()]).toEqual(["rs1:r:func:a#f@0", "rs1:r:func:b#g@0"]);
  });
});

describe("per-agent sidecars", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reposkein-sidecar-agent-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const rec = (id: string, summary: string) => ({
    id,
    semantic_summary: summary,
    summary_of_hash: "h",
    summary_model: "opus",
    summary_at: "2026-08-20T10:00:00Z",
    summary_by: "agent",
  });

  it("names the file after the writing agent", () => {
    expect(sidecarPath(root, "claude")).toBe(
      join(root, ".reposkein", "local", "summaries-claude.jsonl")
    );
  });

  it("falls back to one stable file when no agent is set", () => {
    expect(sidecarPath(root, "")).toBe(join(root, ".reposkein", "local", "summaries-agent.jsonl"));
    expect(agentSlug(undefined)).toBe("agent");
  });

  it("sanitises an agent name into a safe file component", () => {
    // REPOSKEIN_AGENT comes from whatever launched the server: it must never be
    // able to steer the write out of local/.
    expect(agentSlug("../../etc/passwd")).not.toContain("/");
    expect(agentSlug("Claude Code 4.5")).toBe("claude-code-4.5");
    expect(agentSlug("!!!")).toBe("agent");
    expect(agentSlug("x".repeat(200)).length).toBeLessThanOrEqual(40);
  });

  it("keeps two agents on one checkout from overwriting each other", () => {
    // The bug this fixes: upsertSidecar rewrites the whole file, so with one
    // shared file the slower writer's prose vanished with no error anywhere.
    upsertSidecar(sidecarPath(root, "claude"), rec("rs1:r:func:a#f@0", "by claude"));
    upsertSidecar(sidecarPath(root, "codex"), rec("rs1:r:func:b#g@0", "by codex"));

    const all = readAllSidecars(root);
    expect(all.get("rs1:r:func:a#f@0")?.semantic_summary).toBe("by claude");
    expect(all.get("rs1:r:func:b#g@0")?.semantic_summary).toBe("by codex");
  });

  it("still reads a pre-split local/summaries.jsonl an older client wrote", () => {
    upsertSidecar(join(root, ".reposkein", "local", "summaries.jsonl"), rec("old", "legacy"));
    expect(readAllSidecars(root).get("old")?.semantic_summary).toBe("legacy");
  });

  it("merges agents by the same rule the indexer uses, not by directory order", () => {
    // All three carry the same day-precision summary_at, so this is a genuine
    // tie inside one source: resolved by raw-line byte order, exactly as the
    // Rust indexer resolves it. A last-file-wins merge here would serve prose
    // the next `index` is about to replace.
    for (const agent of ["zed", "alpha", "mid"]) {
      upsertSidecar(sidecarPath(root, agent), rec("shared", `by ${agent}`));
    }
    expect(readAllSidecars(root).get("shared")?.semantic_summary).toBe("by alpha");
    expect(sidecarPaths(root).map((p) => p.split("/").pop())).toEqual([
      "summaries-alpha.jsonl",
      "summaries-mid.jsonl",
      "summaries-zed.jsonl",
    ]);
  });

  it("preserves the agents that lost the tie instead of dropping them", () => {
    // Two agents summarising the same node is a real divergence. Silently
    // keeping one used to lose the other with no trace anywhere.
    for (const agent of ["zed", "alpha"]) {
      upsertSidecar(sidecarPath(root, agent), rec("shared", `by ${agent}`));
    }
    const loaded = loadAllSidecars(root);
    expect(loaded.summaries.get("shared")?.props.semantic_summary).toBe("by alpha");
    expect(loaded.conflicts).toHaveLength(1);
    expect(loaded.conflicts[0]!.props.semantic_summary).toBe("by zed");
  });

  it("lets a newer summary_at win regardless of which file it is in", () => {
    upsertSidecar(sidecarPath(root, "zed"), {
      ...rec("shared", "older"),
      summary_at: "2026-01-01",
    });
    upsertSidecar(sidecarPath(root, "alpha"), {
      ...rec("shared", "newer"),
      summary_at: "2026-09-01",
    });
    expect(readAllSidecars(root).get("shared")?.semantic_summary).toBe("newer");
  });

  it("lists nothing for a repo with no sidecars", () => {
    expect(sidecarPaths(root)).toEqual([]);
    expect(readAllSidecars(root).size).toBe(0);
    expect(loadAllSidecars(root).conflicts).toEqual([]);
  });
});
