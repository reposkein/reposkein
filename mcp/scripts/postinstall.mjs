// Best-effort: fetch the prebuilt indexer binary at install time. Never fails
// the install — offline/CI/dev degrade to lazy fetch on first use or PATH.

let downloadBinary;
try {
  ({ downloadBinary } = await import("../dist/indexer/fetchBinary.js"));
} catch {
  console.error("reposkein: dist not built yet; skipping indexer prefetch.");
  process.exit(0);
}
try {
  const path = await downloadBinary();
  console.error(`reposkein: fetched indexer binary -> ${path}`);
} catch (e) {
  console.error(
    `reposkein: skipped indexer prefetch (${e instanceof Error ? e.message : e}); ` +
      `fetched on first use, or set REPOSKEIN_INDEXER_BIN.`
  );
}
