/** Dependency-free ANSI styling for `reposkein-mcp stats` — raw escape codes,
 *  no chalk/picocolors. Auto-disables when stdout isn't a TTY or `NO_COLOR`
 *  is set (https://no-color.org), per the zero-infra/deterministic-tooling
 *  convention: never assume a terminal, never require a dependency for a
 *  cosmetic feature.
 *
 *  Colors: teal `#2DD4BF` ≈ ANSI 256 color 44 (`38;5;44`), amber ≈ 256 color
 *  214 (`38;5;214`) — same palette as the project's README banners. Falls
 *  back to the portable 16-color codes (36 cyan, 33 yellow) is intentionally
 *  NOT done: 256-color support is effectively universal on anything that
 *  reports `isTTY`, and matching the brand hex matters more here than
 *  supporting truly ancient terminals for a purely cosmetic CLI report. */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const TEAL = "\x1b[38;5;44m";
const AMBER = "\x1b[38;5;214m";

export function colorEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined) return false;
  return !!stream.isTTY;
}

export interface Styler {
  teal(s: string): string;
  amber(s: string): string;
  bold(s: string): string;
  dim(s: string): string;
}

const identity: Styler = {
  teal: (s) => s,
  amber: (s) => s,
  bold: (s) => s,
  dim: (s) => s,
};

const styled: Styler = {
  teal: (s) => `${TEAL}${s}${RESET}`,
  amber: (s) => `${AMBER}${s}${RESET}`,
  bold: (s) => `${BOLD}${s}${RESET}`,
  dim: (s) => `${DIM}${s}${RESET}`,
};

/** Returns the styling functions to use, given whether color is enabled —
 *  callers pass `colorEnabled()`'s result so this stays pure/testable. */
export function styler(enabled: boolean): Styler {
  return enabled ? styled : identity;
}
