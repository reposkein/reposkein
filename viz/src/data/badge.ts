/** Staleness badge helpers (design: "Host your constellation" — see
 *  docs/HOSTING.md). Pure formatting logic, kept separate from Root.tsx so it
 *  has its own unit-test surface without needing to render React. */

import type { RepoMeta } from "./api";

/** Shortens a commit sha to the conventional 7-char display form. Falsy /
 *  short input passes through unchanged (never throws). */
export function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

/** Coarse, human "N unit(s) ago" relative-age string computed at render time
 *  from a baked/observed ISO timestamp. Deterministic given `now`. Buckets:
 *  seconds < 60, minutes < 60, hours < 24, days < 30, months < 12, years. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown age";
  const deltaMs = Math.max(0, now - then);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.floor(month / 12);
  return `${year}y ago`;
}

export interface BadgeInfo {
  label: string;
  href: string | null;
}

/** Builds the staleness badge's label + link from repo metadata, or null when
 *  there isn't enough to show anything meaningful (no commitSha at all — the
 *  common case for a repo with no git history, or an old export). `href` is
 *  null when a commit link can't be built (no repoUrl) but the label still
 *  renders (sha + age alone are still useful). */
export function badgeInfo(meta: RepoMeta | null, now: number = Date.now()): BadgeInfo | null {
  if (!meta || !meta.commitSha) return null;
  const sha = shortSha(meta.commitSha);
  const age = meta.builtAt ? relativeAge(meta.builtAt, now) : null;
  const label = age ? `graph @ ${sha} · ${age}` : `graph @ ${sha}`;
  const href = meta.repoUrl ? `${meta.repoUrl}/commit/${meta.commitSha}` : null;
  return { label, href };
}
