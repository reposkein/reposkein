/** Pure filename derivation for the PNG screenshot export (design: share &
 *  scale §P1). Kept in its own module (no r3f imports) so it's unit-testable
 *  under the node vitest environment. */

/** Sanitize a repoId into a filesystem-safe screenshot filename. */
export function screenshotFilename(repoId: string | undefined): string {
  const stem = (repoId ?? "repo")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `reposkein-${stem || "repo"}.png`;
}
