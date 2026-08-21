import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/** Vite plugin: regenerates `src/styles/tokens.generated.css` from
 *  `src/styles/tokens.ts` (which reads `src/scene/encoding.ts`, the SSoT).
 *
 *  Why bundle-then-import instead of parsing encoding.ts: the renderer is real
 *  TypeScript that imports the encoding tables, so the ONLY way to keep the
 *  generator and the app agreeing is to execute the same module. esbuild bundles
 *  it (resolving the relative import) into an in-memory ESM string which is
 *  imported from a data: URL — no temp files, no extra runtime, and the exact
 *  function the unit test asserts determinism on.
 *
 *  Idempotent: the file is only written when the bytes change, so `vite dev`
 *  doesn't loop on its own watcher and `git status` stays clean (the file is
 *  git-ignored anyway). */
export function reposkeinTokens(vizRoot: string): Plugin {
  const entry = resolve(vizRoot, "src/styles/tokens.ts");
  const encoding = resolve(vizRoot, "src/scene/encoding.ts");
  const out = resolve(vizRoot, "src/styles/tokens.generated.css");

  async function generate(): Promise<void> {
    const bundled = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      logLevel: "silent",
    });
    const code = bundled.outputFiles[0]?.text;
    if (!code) throw new Error("[reposkein-tokens] esbuild produced no output");
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    )) as { renderTokensCss: () => string };
    const css = mod.renderTokensCss();
    let previous: string | null = null;
    try {
      previous = readFileSync(out, "utf8");
    } catch {
      previous = null;
    }
    if (previous === css) return;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, css);
  }

  return {
    name: "reposkein-tokens",
    // `config` is the earliest hook, so the file exists before Vite resolves
    // the @import in src/index.css (dev server AND build).
    async config() {
      await generate();
    },
    configureServer(server) {
      // Editing encoding.ts (or the renderer) regenerates immediately; the CSS
      // write is what triggers Vite's own HMR for the stylesheet.
      server.watcher.add([encoding, entry]);
      const onChange = (file: string) => {
        if (file === encoding || file === entry) void generate();
      };
      server.watcher.on("change", onChange);
    },
  };
}
