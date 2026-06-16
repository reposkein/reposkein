// Copies the prebuilt viz/ SPA bundle (viz/dist) into mcp/dist/viz so the
// `reposkein-mcp view` server can serve it and it ships in the npm tarball.
//
// The viz/ package is on pnpm and is NOT built here automatically (to keep
// mcp's npm-only build hermetic). If viz/dist is missing, this prints how to
// build it and exits 0 (a registry/git install already carries dist/viz).
//
// To produce viz/dist:  cd ../viz && pnpm install && pnpm run build
import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // mcp/scripts
const src = join(here, "..", "..", "viz", "dist"); // repo-root viz/dist
const dest = join(here, "..", "dist", "viz"); // mcp/dist/viz

if (existsSync(join(src, "index.html"))) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.error(`reposkein: bundled viz/ -> ${dest}`);
} else {
  if (existsSync(join(dest, "index.html"))) {
    console.error("reposkein: viz/dist not found; using existing dist/viz bundle.");
  } else {
    console.error(
      "reposkein: viz/dist not found and no dist/viz present.\n" +
        "  Build the viewer first:  cd viz && pnpm install && pnpm run build\n" +
        "  (the `reposkein-mcp view` command will report a missing bundle until then)."
    );
  }
}
