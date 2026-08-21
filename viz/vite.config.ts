import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { reposkeinTokens } from "./vite/tokens-plugin";

const vizRoot = dirname(fileURLToPath(import.meta.url));

// base: "./" so hashed assets resolve under any port the `view` server picks.
export default defineConfig({
  base: "./",
  // reposkeinTokens runs first: it writes src/styles/tokens.generated.css (the
  // @theme block derived from scene/encoding.ts) before Tailwind reads the CSS
  // entry. Tailwind v4 is wired through its own Vite plugin (no PostCSS config);
  // preflight is deliberately NOT imported — see src/index.css and AGENTS.md.
  plugins: [reposkeinTokens(vizRoot), tailwindcss(), react()],
  resolve: {
    // shadcn's canonical alias (components.json). Mirrored in tsconfig paths.
    alias: { "@": resolve(vizRoot, "src") },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    // `three` is an irreducible ~735 kB vendor chunk (already isolated below).
    // Raise the warning threshold just past it so the build stays quiet while
    // a regression that bloats any *other* chunk past 800 kB still surfaces.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Split heavy vendor libs into their own chunks so the initial bundle
        // is smaller (faster first paint) and the >500 kB chunk warning is
        // silenced. Keep this an id-based function so unmatched deps fall back
        // to Vite's default chunking. base:"./" keeps every chunk relatively
        // referenced — manualChunks does not affect the relative-path export.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (/node_modules\/three\//.test(id)) return "three";
            if (
              /node_modules\/(@react-three\/(fiber|drei|postprocessing)|postprocessing)\//.test(
                id,
              )
            ) {
              return "r3f";
            }
            if (/node_modules\/@tanstack\//.test(id)) return "tanstack";
          }
        },
      },
    },
  },
  worker: {
    format: "es",
  },
});
