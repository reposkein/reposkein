import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Integration suites share one Neo4j instance and several reuse the same
    // fixture repo_id (e.g. "proftest"), each DETACH-DELETEing it in
    // setup/teardown. Running test files in parallel races on that shared
    // state, so execute files sequentially. The suite is fast enough that the
    // cost is negligible.
    fileParallelism: false,
  },
});
