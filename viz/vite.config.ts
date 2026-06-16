import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" so hashed assets resolve under any port the `view` server picks.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    target: "es2022",
  },
  worker: {
    format: "es",
  },
});
