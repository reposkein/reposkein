import { describe, it, expect } from "vitest";
import {
  buildGraphDataJs,
  injectGraphDataScript,
  parseViewArgs,
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
});
