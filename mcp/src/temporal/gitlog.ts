/**
 * Git-log mining: co-change, churn, and ownership signals.
 *
 * One `git log --no-merges --name-status -z --date=short` pass yields all three
 * signals. Rename chains are reconstructed from R records so a file's history
 * follows it across moves. Bulk commits (>K files) are excluded from co-change
 * counting but still counted for churn. Min-support floor drops one-off pairs.
 *
 * All output ordering is by explicit sort keys — never Map iteration order.
 */

export interface CommitRecord {
  sha: string;
  date: string;         // short ISO date e.g. "2026-06-15"
  author_name: string;
  author_email: string;
  files: string[];      // current canonical paths (renames already resolved)
}

export interface TemporalStats {
  head_sha: string;
  shallow: boolean;     // true → numbers are advisory (shallow clone detected)
  files: Record<string, {
    change_count: number;
    last_changed: string;                          // ISO date
    authors: { name: string; commits: number }[]; // top 5, desc commits then name asc
  }>;
  cochange: Record<string, { path: string; support: number; confidence: number }[]>;
}

// ── parseGitLog ──────────────────────────────────────────────────────────────

/**
 * Parse output of:
 *   git log --no-merges --name-status -z --date=short
 *       --format='%x00%H%x1f%ad%x1f%aN%x1f%aE'
 *
 * The `-z` flag makes git NUL-terminate each path in the name-status block.
 * We split on NUL to get tokens, then detect the commit header lines
 * (which start with NUL %H %ad %aN %aE joined by FS=\x1f).
 *
 * Rename records arrive as e.g. `R100\toldpath\0newpath\0`.
 * With -z, git emits: <status>\0<path1>\0 and for renames <status>\0<path1>\0<path2>\0.
 *
 * Actual git -z --name-status output format (tested):
 *   \0<sha>\x1f<date>\x1f<name>\x1f<email>\n\n<status>\0<path>\0...<status>\0<old>\0<new>\0
 * The commit separator is "\n\n" before the header NUL. We split entire output
 * on the pattern "\x00\x00" (double NUL that appears between commits in -z mode)
 * combined with the leading-NUL header.
 *
 * Strategy: split on NUL → walk tokens; whenever we see a token matching
 * /^\x00<sha>\x1f.../ we start a new commit header; otherwise collect
 * name-status entries.
 */
export function parseGitLog(raw: string): CommitRecord[] {
  if (!raw.trim()) return [];

  // With --format='%x00%H%x1f%ad%x1f%aN%x1f%aE' and -z, each commit header
  // is emitted as a NUL-prefixed record. The name-status entries follow,
  // NUL-separated, then the next commit header starts with NUL again.
  // Split on NUL and walk tokens.
  const tokens = raw.split("\x00");

  const commits: CommitRecord[] = [];
  let current: { sha: string; date: string; name: string; email: string } | null = null;
  // raw file pairs for current commit before rename resolution: [status, path, ?renameTo]
  let rawFiles: Array<{ status: string; path: string; renameTo?: string }> = [];

  const flush = () => {
    if (!current) return;
    commits.push({ sha: current.sha, date: current.date, author_name: current.name, author_email: current.email, files: [] });
    // attach raw files for post-processing (we store them temporarily)
    (commits[commits.length - 1] as CommitRecord & { _raw?: typeof rawFiles })._raw = rawFiles;
    rawFiles = [];
    current = null;
  };

  /** Regex that matches a commit header token: 40 hex chars then \x1f */
  const HEADER_RE = /^[0-9a-f]{40}\x1f/;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // Commit headers start with \x00 then SHA\x1fDATE\x1fNAME\x1fEMAIL
    // Since we split on \x00, the header token itself (after the leading NUL
    // is consumed by split) may look like: \nSHA\x1f... or SHA\x1f...
    // The very first token before any NUL may be empty or contain a newline.
    // We use a shape match (40-hex + \x1f) rather than just \x1f presence so
    // that filenames or author fields containing \x1f don't trigger a false header.
    const clean = tok.replace(/^\s+/, "");
    if (HEADER_RE.test(clean)) {
      // This is a commit header
      flush();
      const parts = clean.split("\x1f");
      if (parts.length >= 4) {
        current = {
          sha: parts[0]!.trim(),
          date: parts[1]!.trim(),
          name: parts[2]!.trim(),
          email: parts[3]!.trim(),
        };
      }
      continue;
    }

    // Skip empty tokens / whitespace-only tokens (between commits, end of output)
    const t = tok.trim();
    if (!t) continue;

    if (!current) continue; // haven't seen a commit header yet

    // Name-status tokens: "M", "A", "D", "R100", "C100", ...
    // In -z mode: after a status token, the next token(s) are paths.
    // We handle this by peeking ahead.
    if (/^[MADRCTU]\d*$/.test(t)) {
      const status = t[0]!;
      if (status === "R" || status === "C") {
        // rename/copy: next two tokens are old-path and new-path
        const oldPath = tokens[++i]?.trim() ?? "";
        const newPath = tokens[++i]?.trim() ?? "";
        if (oldPath && newPath) {
          rawFiles.push({ status, path: oldPath, renameTo: newPath });
        }
      } else {
        const path = tokens[++i]?.trim() ?? "";
        if (path) {
          rawFiles.push({ status, path });
        }
      }
    }
    // If the token doesn't match a status code and isn't empty, it's likely a
    // stray path token already consumed above — ignore.
  }
  flush();

  // ── Rename chain reconstruction ───────────────────────────────────────────
  // Git log outputs commits newest-first. A rename record `R old → new` in
  // commit C means: at C, the file was renamed from `old` to `new`.
  // Any commits OLDER than C that reference `old` should be canonicalized
  // to `new` (the current name).
  //
  // Algorithm: process commits in git-log order (newest first).
  // Maintain aliasMap: old-name → current-canonical-name.
  // - For non-rename files: apply aliasMap to get canonical name.
  // - For rename records (R/C): add oldPath → newPath to aliasMap (so
  //   older commits referencing oldPath map to newPath). Also add oldPath
  //   as a file in this commit (it was touched — it's being renamed).
  //   The newPath is already in aliasMap for future lookups.
  const aliasMap = new Map<string, string>();

  const resolved = commits.map((c) => {
    const raw = (c as CommitRecord & { _raw?: Array<{ status: string; path: string; renameTo?: string }> })._raw ?? [];
    const canonPaths = new Set<string>();

    for (const f of raw) {
      if (f.status === "R" || f.status === "C") {
        // This commit touched both old and new paths (it performed the rename).
        // The canonical name for oldPath is newPath (or whatever newPath maps to).
        if (f.renameTo) {
          const canonNew = resolveAlias(f.renameTo, aliasMap);
          canonPaths.add(canonNew);
          // Record: older commits using oldPath should map to canonNew
          aliasMap.set(f.path, canonNew);
        }
      } else {
        const canon = resolveAlias(f.path, aliasMap);
        canonPaths.add(canon);
      }
    }
    return { ...c, files: [...canonPaths].sort() };
  });

  return resolved;
}

function resolveAlias(path: string, aliasMap: Map<string, string>): string {
  let cur = path;
  const seen = new Set<string>();
  while (aliasMap.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = aliasMap.get(cur)!;
  }
  return cur;
}

// ── computeTemporal ──────────────────────────────────────────────────────────

export function computeTemporal(
  commits: CommitRecord[],
  opts: {
    headSha: string;
    shallow: boolean;
    maxFilesPerCommit?: number;
    minSupport?: number;
    topCoChanged?: number;
    topAuthors?: number;
  },
): TemporalStats {
  const K = opts.maxFilesPerCommit ?? 50;
  const minSupport = opts.minSupport ?? 3;
  const topCoChanged = opts.topCoChanged ?? 20;
  const topAuthors = opts.topAuthors ?? 5;

  // Per-file: churn counts, dates, author tallies
  const changeCount = new Map<string, number>();
  const lastChanged = new Map<string, string>();
  const authorCommits = new Map<string, Map<string, number>>(); // file → author_name → count

  // Pairwise co-change counts (both directions stored): key = "a\x1fb"
  const pairCount = new Map<string, number>();

  for (const commit of commits) {
    const files = commit.files;

    // ── churn (all commits including bulk) ───────────────────────────────
    for (const f of files) {
      changeCount.set(f, (changeCount.get(f) ?? 0) + 1);
      const prev = lastChanged.get(f);
      if (!prev || commit.date > prev) lastChanged.set(f, commit.date);

      // author tally
      let am = authorCommits.get(f);
      if (!am) { am = new Map(); authorCommits.set(f, am); }
      am.set(commit.author_name, (am.get(commit.author_name) ?? 0) + 1);
    }

    // ── co-change (exclude bulk commits) ─────────────────────────────────
    if (files.length < 2 || files.length > K) continue;

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i]!;
        const b = files[j]!;
        const key = a < b ? `${a}\x1f${b}` : `${b}\x1f${a}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  // ── Build cochange map ────────────────────────────────────────────────────
  // For each pair with support ≥ minSupport, compute confidence(a→b) and confidence(b→a).
  const cochangeRaw = new Map<string, Array<{ path: string; support: number; confidence: number }>>();

  for (const [key, support] of pairCount.entries()) {
    if (support < minSupport) continue;
    const [a, b] = key.split("\x1f") as [string, string];
    const countA = changeCount.get(a) ?? 1;
    const countB = changeCount.get(b) ?? 1;
    const confAB = support / countA;
    const confBA = support / countB;

    if (!cochangeRaw.has(a)) cochangeRaw.set(a, []);
    if (!cochangeRaw.has(b)) cochangeRaw.set(b, []);
    cochangeRaw.get(a)!.push({ path: b, support, confidence: confAB });
    cochangeRaw.get(b)!.push({ path: a, support, confidence: confBA });
  }

  // Sort each file's co-change list: confidence desc, support desc, path asc
  const cochange: Record<string, { path: string; support: number; confidence: number }[]> = {};
  // Sort files for deterministic output
  const cochangeFiles = [...cochangeRaw.keys()].sort();
  for (const f of cochangeFiles) {
    const list = cochangeRaw.get(f)!;
    list.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.support !== a.support) return b.support - a.support;
      // Codepoint comparison for cross-locale determinism
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    cochange[f] = list.slice(0, topCoChanged);
  }

  // ── Build files map ───────────────────────────────────────────────────────
  const files: TemporalStats["files"] = {};
  // Sort file keys for deterministic output
  const fileKeys = [...changeCount.keys()].sort();
  for (const f of fileKeys) {
    const am = authorCommits.get(f) ?? new Map<string, number>();
    // Sort authors: commits desc, then name asc
    const authors = [...am.entries()]
      .sort(([na, ca], [nb, cb]) => {
        if (cb !== ca) return cb - ca;
        // Codepoint comparison for cross-locale determinism
        return na < nb ? -1 : na > nb ? 1 : 0;
      })
      .slice(0, topAuthors)
      .map(([name, commits]) => ({ name, commits }));

    files[f] = {
      change_count: changeCount.get(f) ?? 0,
      last_changed: lastChanged.get(f) ?? "",
      authors,
    };
  }

  return {
    head_sha: opts.headSha,
    shallow: opts.shallow,
    files,
    cochange,
  };
}
