import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" so hashed assets resolve under any port the `view` server picks.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    target: "es2022",
    // `three` is an irreducible ~680 kB vendor chunk (already isolated below).
    // Raise the warning threshold just past it so the build stays quiet while
    // a regression that bloats any *other* chunk past 700 kB still surfaces.
    chunkSizeWarningLimit: 700,
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
