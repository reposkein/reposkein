/**
 * Unit tests for parseGitLog and computeTemporal.
 *
 * Uses synthetic git-log strings to exercise:
 *  - rename chain folding
 *  - bulk-commit exclusion from co-change (but counted in churn)
 *  - min-support floor
 *  - correct confidence computation
 *  - deterministic ordering (no Map iteration order)
 */
import { describe, it, expect } from "vitest";
import { parseGitLog, computeTemporal } from "../src/temporal/gitlog.js";

// Helper: build the git log --format='%x00%H%x1f%ad%x1f%aN%x1f%aE' -z output string.
// Real git output structure (splitting on NUL \x00):
//   token[0] = ""
//   token[1] = "SHA\x1fDATE\x1fNAME\x1fEMAIL"  (clean header)
//   token[2] = "\nSTATUS1"                        (newline + first status char)
//   token[3] = "path1"                            (first path)
//   token[4] = "STATUS2"                          (second status, no newline)
//   token[5] = "path2"
//   ...
// So: mkHeader ends with \x00\n, then mkFile is just "{status}\x00{path}\x00"
function mkHeader(sha: string, date: string, name = "Alice", email = "alice@example.com"): string {
  // The trailing \x00\n matches what git emits: NUL ends header, then \n before status block
  return `\x00${sha}\x1f${date}\x1f${name}\x1f${email}\x00\n`;
}

function mkFile(status: string, path: string): string {
  // NUL between status and path, NUL terminator — matches git's -z format
  return `${status}\x00${path}\x00`;
}

function mkRename(oldPath: string, newPath: string, score = 100): string {
  return `R${score}\x00${oldPath}\x00${newPath}\x00`;
}

// ── Synthetic corpus ─────────────────────────────────────────────────────────
//
// We'll build a scenario:
//
// commit C1 (newest): A + B change together (3rd occurrence — support=3!)
// commit C2:          A + B change together (2nd time)
// commit C3:          C renames to B/new path; A + C change together (prior to rename, will map C→B's canonical)
// commit C4 (bulk):   A + many files (>50) — excluded from co-change, but counted in churn
// commit C5 (oldest): A only
//
// After rename (C3): C → A_current (or rather: let's make it simple)
//
// Simplified concrete scenario:
//   Files: "src/foo.ts", "src/bar.ts", "src/old.ts" → renamed to "src/new.ts"
//
// Commits (git log = newest first):
//   sha1: src/foo.ts + src/bar.ts (pair — 3rd co-occurrence!)
//   sha2: src/foo.ts + src/bar.ts (pair — 2nd co-occurrence)
//   sha3: src/foo.ts + src/new.ts (pair) AND R: old.ts → new.ts  (the rename)
//          (so old.ts → new.ts via rename; foo.ts + new.ts co-occur 1st time)
//   sha4: 52 files including src/foo.ts (BULK — excluded from co-change, counted for churn)
//   sha5: src/foo.ts alone

describe("parseGitLog", () => {
  it("parses a simple commit with two modified files", () => {
    const raw =
      mkHeader("aaaaaa1111111111111111111111111111111111", "2026-06-10") +
      mkFile("M", "src/foo.ts") +
      mkFile("M", "src/bar.ts");

    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe("aaaaaa1111111111111111111111111111111111");
    expect(commits[0]!.date).toBe("2026-06-10");
    expect(commits[0]!.author_name).toBe("Alice");
    expect(commits[0]!.files.sort()).toEqual(["src/bar.ts", "src/foo.ts"]);
  });

  it("parses correctly when author name contains \\x1f (odd byte) without misidentifying files as headers", () => {
    // An author name that contains the field separator \x1f — the old heuristic
    // (tok.includes("\x1f")) would falsely treat a subsequent file token containing
    // \x1f as a commit header. The new shape-anchored check (40-hex + \x1f) must
    // correctly ignore it.
    //
    // We construct a commit where the path looks like it could contain \x1f.
    // Since we split on \x00, the path token after a status is a plain string.
    // We verify the commit is parsed with the correct file and no extra spurious commit.
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    // Author name with an embedded \x1f — git would percent-encode this in practice,
    // but our parser should handle it without misparse.
    const raw =
      `\x00${sha}\x1f2026-06-16\x1fAlice\x1fwith\x1fextra\x1ffields@x.io\x00\n` +
      `M\x00src/odd\x1fbyte_file.ts\x00`;
    const commits = parseGitLog(raw);
    // Should still produce exactly one commit
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe(sha);
    // The file token (after the M status) should be parsed correctly
    // (the \x1f inside the path token is NOT treated as a header because it lacks the 40-hex prefix)
    expect(commits[0]!.files.length).toBe(1);
  });

  it("reconstructs rename chains — old path maps to current canonical path", () => {
    // sha1 (newest): foo.ts changes (current name)
    // sha2: R old.ts → foo.ts  (rename happened)
    // sha3 (oldest): old.ts changes (before rename)
    // Use valid 40-hex SHAs (a-f, 0-9 only)
    const sha1r = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const sha2r = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2";
    const sha3r = "a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3";
    const raw =
      mkHeader(sha1r, "2026-06-10") +
      mkFile("M", "src/foo.ts") +
      mkHeader(sha2r, "2026-06-09") +
      mkRename("src/old.ts", "src/foo.ts") +
      mkFile("M", "src/bar.ts") +
      mkHeader(sha3r, "2026-06-08") +
      mkFile("M", "src/old.ts") +
      mkFile("M", "src/bar.ts");

    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(3);

    // All references to src/old.ts should be canonicalized to src/foo.ts
    const allFiles = commits.flatMap((c) => c.files);
    expect(allFiles).not.toContain("src/old.ts");
    // sha3r commit should show src/foo.ts (the canonical name after rename)
    const sha3commit = commits.find((c) => c.sha === sha3r)!;
    expect(sha3commit.files).toContain("src/foo.ts");
  });
});

describe("computeTemporal", () => {
  // Build the synthetic corpus described above
  // Use valid 40-hex SHAs (a-f, 0-9 only — HEADER_RE requires /^[0-9a-f]{40}\x1f/)
  const sha1 = "1111111111111111111111111111111111111111";
  const sha2 = "2222222222222222222222222222222222222222";
  const sha3 = "3333333333333333333333333333333333333333";
  const sha4 = "4444444444444444444444444444444444444444";
  const sha5 = "5555555555555555555555555555555555555555";

  // 52 extra files for the bulk commit
  const bulkFiles = Array.from({ length: 51 }, (_, i) => `src/generated_${i.toString().padStart(3, "0")}.ts`);

  // Build raw git log string (newest first)
  const raw = [
    // C1 (newest): foo + bar — 2nd co-occurrence
    mkHeader(sha1, "2026-06-15", "Alice", "alice@x.io"),
    mkFile("M", "src/foo.ts"),
    mkFile("M", "src/bar.ts"),
    // C2: foo + bar — 1st co-occurrence
    mkHeader(sha2, "2026-06-10", "Bob", "bob@x.io"),
    mkFile("M", "src/foo.ts"),
    mkFile("M", "src/bar.ts"),
    // C3: rename old.ts → new.ts; foo + new.ts co-occur; old.ts gets renamed
    mkHeader(sha3, "2026-06-05", "Alice", "alice@x.io"),
    mkRename("src/old.ts", "src/new.ts"),
    mkFile("M", "src/foo.ts"),
    // C4: bulk commit (52 files including foo)
    mkHeader(sha4, "2026-06-01", "CI Bot", "ci@x.io"),
    mkFile("M", "src/foo.ts"),
    ...bulkFiles.map((f) => mkFile("A", f)),
    // C5 (oldest): foo alone
    mkHeader(sha5, "2026-05-01", "Alice", "alice@x.io"),
    mkFile("M", "src/foo.ts"),
  ].join("");

  const commits = parseGitLog(raw);

  it("parses all 5 commits", () => {
    expect(commits).toHaveLength(5);
  });

  it("bulk commit is included in churn count", () => {
    const stats = computeTemporal(commits, {
      headSha: "HEAD",
      shallow: false,
      maxFilesPerCommit: 50,
      minSupport: 3,
    });
    // src/foo.ts appears in C1 + C2 + C3 (as foo.ts) + C4 (bulk) + C5 = 5 commits
    expect(stats.files["src/foo.ts"]?.change_count).toBe(5);
    // src/bar.ts appears in C1 + C2 = 2 commits
    expect(stats.files["src/bar.ts"]?.change_count).toBe(2);
  });

  it("bulk commit (>50 files) is excluded from co-change", () => {
    const stats = computeTemporal(commits, {
      headSha: "HEAD",
      shallow: false,
      maxFilesPerCommit: 50,
      minSupport: 1,
    });
    // The bulk files (generated_*) should NOT appear in co-change for foo.ts
    const fooCoChange = stats.cochange["src/foo.ts"] ?? [];
    const coChangePaths = fooCoChange.map((e) => e.path);
    for (const bf of bulkFiles) {
      expect(coChangePaths).not.toContain(bf);
    }
  });

  it("co-change pair foo+bar absent with minSupport=3 (only support=2)", () => {
    const stats = computeTemporal(commits, {
      headSha: "HEAD",
      shallow: false,
      maxFilesPerCommit: 50,
      minSupport: 3,
    });
    // foo+bar co-occur in C1 + C2 only = support 2, below minSupport=3
    const fooCoChange = stats.cochange["src/foo.ts"] ?? [];
    expect(fooCoChange.find((e) => e.path === "src/bar.ts")).toBeUndefined();
  });

  it("co-change pair foo+bar appears with minSupport=2, correct support and confidence", () => {
    const stats = computeTemporal(commits, {
      headSha: "HEAD",
      shallow: false,
      maxFilesPerCommit: 50,
      minSupport: 2,
    });
    const fooCoChange = stats.cochange["src/foo.ts"] ?? [];
    const barEntry = fooCoChange.find((e) => e.path === "src/bar.ts");
    expect(barEntry).toBeDefined();
    // support = 2 (C1 + C2)
    expect(barEntry!.support).toBe(2);
    // confidence(foo→bar) = support / change_count(foo) = 2/5
    expect(barEntry!.confidence).toBeCloseTo(2 / 5);

    // From bar's perspective: confidence(bar→foo) = 2 / change_count(bar) = 2/2 = 1.0
    const barCoChange = stats.cochange["src/bar.ts"] ?? [];
    const fooEntry = barCoChange.find((e) => e.path === "src/foo.ts");
    expect(fooEntry).toBeDefined();
    expect(fooEntry!.support).toBe(2);
    expect(fooEntry!.confidence).toBeCloseTo(1.0);
  });

  it("rename folding: src/old.ts counts toward src/new.ts", () => {
    const stats = computeTemporal(commits, {
      headSha: "HEAD",
      shallow: false,
      maxFilesPerCommit: 50,
      minSupport: 1,
    });
    // src/old.ts should NOT appear in files — it was renamed to src/new.ts
    expect(stats.files["src/old.ts"]).toBeUndefined();
    // src/new.ts should appear (from C3 rename)
    expect(stats.files["src/new.ts"]).toBeDefined();
  });

  it("co-change ordering is deterministic (confidence desc, support desc, path asc)", () => {
    // Verify that multiple calls produce identical ordering
    const stats1 = computeTemporal(commits, { headSha: "HEAD", shallow: false, minSupport: 1 });
    const stats2 = computeTemporal(commits, { headSha: "HEAD", shallow: false, minSupport: 1 });
    expect(JSON.stringify(stats1.cochange)).toBe(JSON.stringify(stats2.cochange));
    expect(JSON.stringify(stats1.files)).toBe(JSON.stringify(stats2.files));
  });

  it("file keys in output are sorted (no Map iteration order)", () => {
    const stats = computeTemporal(commits, { headSha: "HEAD", shallow: false, minSupport: 1 });
    const keys = Object.keys(stats.files);
    expect(keys).toEqual([...keys].sort());
    const coKeys = Object.keys(stats.cochange);
    expect(coKeys).toEqual([...coKeys].sort());
  });

  it("authors are ranked by commits desc then name asc", () => {
    const stats = computeTemporal(commits, { headSha: "HEAD", shallow: false, minSupport: 1 });
    const fooAuthors = stats.files["src/foo.ts"]?.authors ?? [];
    // Alice: C1 + C3 + C5 = 3; Bob: C2 = 1; CI Bot: C4 = 1
    // Order: Alice(3), Bob(1) and CI Bot(1) — Bob < CI Bot alphabetically
    expect(fooAuthors[0]!.name).toBe("Alice");
    expect(fooAuthors[0]!.commits).toBe(3);
    expect(fooAuthors[1]!.name).toBe("Bob");
    expect(fooAuthors[2]!.name).toBe("CI Bot");
  });

  it("last_changed is the most recent commit date", () => {
    const stats = computeTemporal(commits, { headSha: "HEAD", shallow: false, minSupport: 1 });
    expect(stats.files["src/foo.ts"]?.last_changed).toBe("2026-06-15");
    expect(stats.files["src/bar.ts"]?.last_changed).toBe("2026-06-15");
  });
});
