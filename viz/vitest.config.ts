import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

const vizRoot = dirname(fileURLToPath(import.meta.url));

// Deliberately NOT vite.config.ts: the test run wants none of the app's build
// pipeline (Tailwind, the token generator, the React plugin) — the suite targets
// pure modules plus a couple of jsdom component tests. Only the `@` alias is
// mirrored so a `@/…` import resolves the same way in both.
export default defineConfig({
  resolve: {
    alias: { "@": resolve(vizRoot, "src") },
  },
  test: {
    // Node by default (the pure data/scene math). Component tests opt into jsdom
    // per file with a `// @vitest-environment jsdom` docblock, so one React test
    // doesn't slow down the other 180.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
