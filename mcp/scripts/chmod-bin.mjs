// Make the compiled bin executable. tsc emits dist/index.js without the +x bit,
// so a bare `./dist/index.js` (or a global-install symlink invoked as an
// executable, or our pack→untar→exec smoke) fails with exit 126. `npm install`
// chmods bins on install, but the packed artifact should be correct on its own.
// Cross-platform: chmod is a no-op-ish on Windows but never throws.
import { chmodSync } from "node:fs";

try {
  chmodSync(new URL("../dist/index.js", import.meta.url), 0o755);
} catch (e) {
  console.error(`reposkein: could not chmod dist/index.js (${e instanceof Error ? e.message : e})`);
}
