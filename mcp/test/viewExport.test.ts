import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildGraphDataJs,
  injectGraphDataScript,
  parseViewArgs,
  runExport,
  resolveServerRepoMeta,
  vizDistDir,
} from "../src/cli/view.js";

describe("buildGraphDataJs (static export baking)", () => {
  it("assigns window.__REPOSKEIN_GRAPH__ with manifest + inlined JSONL", () => {
    const js = buildGraphDataJs(
      "demo",
      '{"id":"a","labels":["File"]}\n',
      '{"from":"a","type":"CALLS","to":"b"}\n',
    );
    expect(js.startsWith("window.__REPOSKEIN_GRAPH__ = ")).toBe(true);
    // The assignment is valid JSON after the prefix and before the trailing ;\n
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as {
      manifest: { root: { repoId: string; repoRoot?: string }; federated: unknown[] };
      nodesText: string;
      edgesText: string;
    };
    expect(payload.manifest.root.repoId).toBe("demo");
    expect(payload.nodesText).toContain('"id":"a"');
    expect(payload.edgesText).toContain('"type":"CALLS"');
    expect(payload.manifest.federated).toEqual([]);
  });

  it("populates manifest.counts from the real node/edge line counts (fix round 2 / REP-22 polish — was hardcoded 0/0)", () => {
    const js = buildGraphDataJs(
      "demo",
      '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n',
      '{"from":"a","to":"b"}\n',
    );
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as { manifest: { counts: { nodes: number; edges: number } } };
    expect(payload.manifest.counts).toEqual({ nodes: 3, edges: 1 });
  });

  it("counts tolerate a missing trailing newline and ignore stray blank lines", () => {
    const js = buildGraphDataJs("demo", '{"id":"a"}\n\n{"id":"b"}', "");
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as { manifest: { counts: { nodes: number; edges: number } } };
    expect(payload.manifest.counts).toEqual({ nodes: 2, edges: 0 });
  });

  it("does NOT bake an absolute repoRoot (shared export, no leak)", () => {
    const js = buildGraphDataJs("demo", "n\n", "e\n");
    expect(js).not.toContain("repoRoot");
  });

  it("safely embeds </script> sequences (external js, no HTML escaping needed)", () => {
    const js = buildGraphDataJs("demo", '{"x":"</script>"}\n', "");
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as { nodesText: string };
    expect(payload.nodesText).toContain("</script>");
  });
});

describe("injectGraphDataScript", () => {
  it("injects the script before the first app bundle <script src=...>", () => {
    const html =
      `<!doctype html><html><head></head><body><div id="root"></div>` +
      `<script type="module" src="/assets/index-abc.js"></script></body></html>`;
    const out = injectGraphDataScript(html);
    const dataIdx = out.indexOf("graph-data.js");
    const appIdx = out.indexOf("/assets/index-abc.js");
    expect(dataIdx).toBeGreaterThan(-1);
    expect(dataIdx).toBeLessThan(appIdx); // baked global set BEFORE app boots
  });

  it("is idempotent", () => {
    const html = `<html><head></head><body><script src="/a.js"></script></body></html>`;
    const once = injectGraphDataScript(html);
    const twice = injectGraphDataScript(once);
    expect(twice).toBe(once);
    expect((twice.match(/graph-data\.js/g) ?? []).length).toBe(1);
  });

  it("falls back to </head> when there is no script src", () => {
    const html = `<html><head><title>x</title></head><body></body></html>`;
    const out = injectGraphDataScript(html);
    expect(out).toContain("graph-data.js");
    expect(out.indexOf("graph-data.js")).toBeLessThan(out.indexOf("</head>"));
  });
});

describe("parseViewArgs --export", () => {
  it("parses --export <dir> with a positional repo path", () => {
    const { repoPath, exportDir } = parseViewArgs(["--export", "out/site", "/repo"]);
    expect(exportDir).toBe("out/site");
    expect(repoPath).toBe("/repo");
  });

  it("parses --export=<dir>", () => {
    const { exportDir } = parseViewArgs(["--export=dist-site"]);
    expect(exportDir).toBe("dist-site");
  });

  it("is null for a normal serve invocation", () => {
    const { exportDir, opts } = parseViewArgs(["--port", "5000"]);
    expect(exportDir).toBeNull();
    expect(opts.port).toBe(5000);
  });

  it("parses --commit-sha / --repo-url / --built-at (bake metadata)", () => {
    const { exportOpts } = parseViewArgs([
      "--export=./_site",
      "--commit-sha",
      "abc123",
      "--repo-url",
      "https://github.com/reposkein/reposkein",
      "--built-at",
      "2026-08-20T00:00:00.000Z",
    ]);
    expect(exportOpts.commitSha).toBe("abc123");
    expect(exportOpts.repoUrl).toBe("https://github.com/reposkein/reposkein");
    expect(exportOpts.builtAt).toBe("2026-08-20T00:00:00.000Z");
  });

  it("parses --commit-sha=<x> equals form", () => {
    const { exportOpts } = parseViewArgs(["--commit-sha=deadbeef"]);
    expect(exportOpts.commitSha).toBe("deadbeef");
  });

  it("parses --with-source with an optional numeric byte cap", () => {
    const withCap = parseViewArgs(["--with-source", "500000"]);
    expect(withCap.exportOpts.withSource).toBe(true);
    expect(withCap.exportOpts.sourceMaxBytes).toBe(500000);

    const withoutCap = parseViewArgs(["--with-source"]);
    expect(withoutCap.exportOpts.withSource).toBe(true);
    expect(withoutCap.exportOpts.sourceMaxBytes).toBeUndefined();
  });

  it("defaults withSource to false and bake fields to null", () => {
    const { exportOpts } = parseViewArgs(["--export=./_site"]);
    expect(exportOpts.withSource).toBe(false);
    expect(exportOpts.commitSha).toBeNull();
    expect(exportOpts.repoUrl).toBeNull();
    expect(exportOpts.builtAt).toBeNull();
  });
});

describe("buildGraphDataJs (bake metadata + temporal + federation)", () => {
  it("bakes meta {commitSha, builtAt, repoUrl} into the payload", () => {
    const js = buildGraphDataJs("demo", "n\n", "e\n", {
      meta: { commitSha: "abc123", builtAt: "2026-08-20T00:00:00.000Z", repoUrl: "https://github.com/o/r" },
    });
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as { meta: { commitSha: string; builtAt: string; repoUrl: string } };
    expect(payload.meta).toEqual({
      commitSha: "abc123",
      builtAt: "2026-08-20T00:00:00.000Z",
      repoUrl: "https://github.com/o/r",
    });
  });

  it("defaults meta to nulls when omitted", () => {
    const js = buildGraphDataJs("demo", "n\n", "e\n");
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as { meta: { commitSha: null; builtAt: null; repoUrl: null } };
    expect(payload.meta).toEqual({ commitSha: null, builtAt: null, repoUrl: null, pagesUrl: null });
  });

  it("bakes the temporal co-change map (same shape /api/temporal returns)", () => {
    const cochange = { "a.ts": [{ path: "b.ts", support: 4, confidence: 0.8 }] };
    const js = buildGraphDataJs("demo", "n\n", "e\n", { cochange });
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as { cochange: typeof cochange };
    expect(payload.cochange).toEqual(cochange);
  });

  it("defaults cochange to {} when omitted", () => {
    const js = buildGraphDataJs("demo", "n\n", "e\n");
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as { cochange: unknown };
    expect(payload.cochange).toEqual({});
  });

  it("bakes federated repos inline (manifest.federated + federatedText, no fetchable URLs)", () => {
    const js = buildGraphDataJs("demo", "n\n", "e\n", {
      federated: [
        { repoId: "widgets", rootPath: "packages/widgets", nodesText: "wn\n", edgesText: "we\n" },
      ],
    });
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as {
      manifest: { federated: { repoId: string; rootPath: string; nodesUrl: string; edgesUrl: string }[] };
      federatedText: { repoId: string; nodesText: string; edgesText: string }[];
    };
    expect(payload.manifest.federated).toEqual([
      { repoId: "widgets", rootPath: "packages/widgets", nodesUrl: "", edgesUrl: "" },
    ]);
    expect(payload.federatedText).toEqual([{ repoId: "widgets", nodesText: "wn\n", edgesText: "we\n" }]);
  });

  it("omits sourceSlices when not provided (no size cost for the common case)", () => {
    const js = buildGraphDataJs("demo", "n\n", "e\n");
    expect(js).not.toContain("sourceSlices");
  });

  it("bakes sourceSlices when provided", () => {
    const js = buildGraphDataJs("demo", "n\n", "e\n", {
      sourceSlices: { "rs1:demo:func:a#f@0": { path: "a.py", start: 1, end: 2, lines: ["x", "y"] } },
    });
    const json = js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, "");
    const payload = JSON.parse(json) as { sourceSlices: Record<string, unknown> };
    expect(payload.sourceSlices["rs1:demo:func:a#f@0"]).toEqual({
      path: "a.py",
      start: 1,
      end: 2,
      lines: ["x", "y"],
    });
  });
});

// Needs the real viz/ SPA bundle at mcp/dist/viz (ci.yml builds it before running
// mcp tests: "Build + bundle viz" -> "Bundle viz into mcp/dist" -> "Tests"). Skipped
// in a plain `npm test` before that bundling step has run.
const distBuilt = existsSync(join(vizDistDir(), "index.html"));
const gated = distBuilt ? describe : describe.skip;

gated("runExport (integration: bakes sha + temporal + federation)", () => {
  it("bakes commitSha/repoUrl/builtAt + a real git-derived temporal co-change map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-export-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
      mkdirSync(join(dir, ".reposkein"), { recursive: true });
      writeFileSync(
        join(dir, ".reposkein", "nodes.jsonl"),
        JSON.stringify({ id: "rs1:demo:file:a.py", labels: ["File"], props: { path: "a.py" } }) + "\n",
      );
      writeFileSync(join(dir, ".reposkein", "edges.jsonl"), "");
      writeFileSync(join(dir, "a.py"), "x = 1\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

      const outDir = join(dir, "_site");
      const code = await runExport(dir, "demo", outDir, {
        commitSha: "deadbeef",
        repoUrl: "https://github.com/o/r",
        builtAt: "2026-08-20T00:00:00.000Z",
      });
      expect(code).toBe(0);

      const js = readFileSync(join(outDir, "graph-data.js"), "utf8");
      const payload = JSON.parse(
        js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, ""),
      ) as {
        meta: { commitSha: string; repoUrl: string; builtAt: string; pagesUrl: string | null };
        cochange: Record<string, unknown>;
        manifest: { federated: unknown[] };
      };
      expect(payload.meta).toEqual({
        commitSha: "deadbeef",
        repoUrl: "https://github.com/o/r",
        builtAt: "2026-08-20T00:00:00.000Z",
        pagesUrl: null,
      });
      // A one-commit repo has no co-change pairs, but the temporal code path
      // must have run without throwing (proves getTemporal was actually called).
      expect(payload.cochange).toEqual({});
      expect(payload.manifest.federated).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults builtAt to bake time when not passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-export-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      mkdirSync(join(dir, ".reposkein"), { recursive: true });
      writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "");
      writeFileSync(join(dir, ".reposkein", "edges.jsonl"), "");
      const outDir = join(dir, "_site");
      const before = Date.now();
      await runExport(dir, "demo", outDir, {});
      const after = Date.now();

      const js = readFileSync(join(outDir, "graph-data.js"), "utf8");
      const payload = JSON.parse(
        js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, ""),
      ) as { meta: { builtAt: string } };
      const t = Date.parse(payload.meta.builtAt);
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("populates federated[] from a nested .reposkein/ repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-export-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      mkdirSync(join(dir, ".reposkein"), { recursive: true });
      writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "");
      writeFileSync(join(dir, ".reposkein", "edges.jsonl"), "");

      const nested = join(dir, "packages", "widgets");
      mkdirSync(join(nested, ".reposkein"), { recursive: true });
      writeFileSync(
        join(nested, ".reposkein", "meta.json"),
        JSON.stringify({ id_scheme: "rs1", indexer_version_min: "0.0.0", repo_id: "widgets", schema_version: 1 }),
      );
      writeFileSync(
        join(nested, ".reposkein", "nodes.jsonl"),
        JSON.stringify({ id: "rs1:widgets:file:x.ts", labels: ["File"], props: { path: "x.ts" } }) + "\n",
      );
      writeFileSync(join(nested, ".reposkein", "edges.jsonl"), "");

      const outDir = join(dir, "_site");
      const code = await runExport(dir, "demo", outDir, {});
      expect(code).toBe(0);

      const js = readFileSync(join(outDir, "graph-data.js"), "utf8");
      const payload = JSON.parse(
        js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, ""),
      ) as {
        manifest: { federated: { repoId: string; rootPath: string }[] };
        federatedText: { repoId: string; nodesText: string }[];
      };
      expect(payload.manifest.federated).toEqual([
        { repoId: "widgets", rootPath: "packages/widgets", nodesUrl: "", edgesUrl: "" },
      ]);
      expect(payload.federatedText[0]!.repoId).toBe("widgets");
      expect(payload.federatedText[0]!.nodesText).toContain("rs1:widgets:file:x.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bakes pagesUrl from the repo's [team] config.toml when not explicitly overridden", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-export-"));
    try {
      mkdirSync(join(dir, ".reposkein"), { recursive: true });
      writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "");
      writeFileSync(join(dir, ".reposkein", "edges.jsonl"), "");
      writeFileSync(
        join(dir, ".reposkein", "config.toml"),
        '[team]\npages_url = "https://reposkein.github.io/example"\n',
      );
      const outDir = join(dir, "_site");
      await runExport(dir, "demo", outDir, {});
      const js = readFileSync(join(outDir, "graph-data.js"), "utf8");
      const payload = JSON.parse(
        js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, ""),
      ) as { meta: { pagesUrl: string | null } };
      expect(payload.meta.pagesUrl).toBe("https://reposkein.github.io/example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an explicit pagesUrl bake option overrides config.toml", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-export-"));
    try {
      mkdirSync(join(dir, ".reposkein"), { recursive: true });
      writeFileSync(join(dir, ".reposkein", "nodes.jsonl"), "");
      writeFileSync(join(dir, ".reposkein", "edges.jsonl"), "");
      writeFileSync(
        join(dir, ".reposkein", "config.toml"),
        '[team]\npages_url = "https://from-config.example"\n',
      );
      const outDir = join(dir, "_site");
      await runExport(dir, "demo", outDir, { pagesUrl: "https://override.example" });
      const js = readFileSync(join(outDir, "graph-data.js"), "utf8");
      const payload = JSON.parse(
        js.replace(/^window\.__REPOSKEIN_GRAPH__ = /, "").replace(/;\n$/, ""),
      ) as { meta: { pagesUrl: string | null } };
      expect(payload.meta.pagesUrl).toBe("https://override.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveServerRepoMeta", () => {
  it("reads pagesUrl from [team] config.toml alongside the git-derived fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-servermeta-"));
    try {
      mkdirSync(join(dir, ".reposkein"), { recursive: true });
      writeFileSync(
        join(dir, ".reposkein", "config.toml"),
        '[team]\npages_url = "https://reposkein.github.io/example"\n',
      );
      const meta = resolveServerRepoMeta(dir);
      expect(meta.pagesUrl).toBe("https://reposkein.github.io/example");
      // Not a git repo — the git-derived fields degrade to null (pre-existing
      // behavior); pagesUrl is independent of git.
      expect(meta.commitSha).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pagesUrl is null when config.toml has no [team] section", () => {
    const dir = mkdtempSync(join(tmpdir(), "rs-servermeta-"));
    try {
      const meta = resolveServerRepoMeta(dir);
      expect(meta.pagesUrl).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
