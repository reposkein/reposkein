// Copies the repo-root skill/SKILL.md into dist/ so it ships in the npm tarball
// and `reposkein-mcp init` can install it. Graceful when the source is absent
// (registry/git installs already have dist/SKILL.md).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // mcp/scripts
const src = join(here, "..", "..", "skill", "SKILL.md"); // repo-root skill/SKILL.md
const distDir = join(here, "..", "dist");
const dest = join(distDir, "SKILL.md");

if (existsSync(src)) {
  mkdirSync(distDir, { recursive: true });
  copyFileSync(src, dest);
  console.error(`reposkein: bundled SKILL.md -> ${dest}`);
} else {
  console.error("reposkein: source skill/SKILL.md not found; assuming dist/SKILL.md already present.");
}
