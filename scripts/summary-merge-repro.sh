#!/bin/sh
#
# Live two-branch merge repro for the committed summary shards.
#
# The automated coverage lives in indexer/crates/cli/tests/summaries_cli.rs and
# mcp/test/summaryShards.test.ts, which simulate merged shard content directly.
# This script is the thing those tests stand in for: real git, real branches,
# a real merge, and the real binary. Run it when changing the shard layout, the
# .gitattributes declaration, or the divergence rule — a unit test cannot tell
# you whether git itself resolved the file.
#
# Usage:
#   sh scripts/summary-merge-repro.sh [path-to-reposkein-indexer] [scratch-dir]
#
# Exits non-zero on the first failed expectation.
set -e

BIN="${1:-$(cd "$(dirname "$0")/.." && pwd)/indexer/target/debug/reposkein-indexer}"
WORK="${2:-${TMPDIR:-/tmp}/reposkein-merge-repro}"

command -v "$BIN" >/dev/null 2>&1 || [ -x "$BIN" ] || {
  echo "no indexer at $BIN — build it with: cd indexer && cargo build" >&2
  exit 2
}

rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

# `index` runs the post-merge hook's DB probe on stderr; silence it, and never
# let the repo's own hooks recurse into this scratch repo.
idx() { "$BIN" index --repo-id r --name d . >/dev/null 2>&1; }
commit() { git -c core.hooksPath=/dev/null commit -qm "$1"; }
merge() { git -c core.hooksPath=/dev/null merge --no-edit -q "$1"; }

# Switching branches the way a SECOND DEVELOPER would see it. nodes.jsonl is
# git-ignored, so it survives a checkout, and `index` harvests summaries out of
# it — which would carry the other branch's prose across and make this repro
# lie about what each branch actually committed.
fresh_checkout() {
  git checkout -q "$@"
  rm -f .reposkein/nodes.jsonl .reposkein/edges.jsonl
}

git init -q .
git config user.email repro@example.com
git config user.name repro
printf 'def f():\n    return 1\n\n\ndef g():\n    return 2\n' > m.py
idx
"$BIN" init --hooks . >/dev/null 2>&1
git add -A
commit base
MAIN=$(git rev-parse --abbrev-ref HEAD)

hash_of() {
  grep -o "{\"id\":\"$1\"[^}]*}" .reposkein/nodes.jsonl \
    | sed 's/.*"content_hash":"\([^"]*\)".*/\1/'
}
FH=$(hash_of 'rs1:r:func:m.py#f@0')
GH=$(hash_of 'rs1:r:func:m.py#g@0')

summarise() { # <sidecar-name> <node-id> <prose> <hash> <timestamp>
  mkdir -p .reposkein/local
  printf '{"id":"%s","semantic_summary":"%s","summary_of_hash":"%s","summary_at":"%s"}\n' \
    "$2" "$3" "$4" "$5" > ".reposkein/local/summaries-$1.jsonl"
  idx
  git add .reposkein/summaries
}

shard_holding() { grep -rl "$1" .reposkein/summaries/ | head -1; }

fail() { echo "FAIL: $1" >&2; exit 1; }

# ---------------------------------------------------------------------------
echo "== two branches summarise DIFFERENT nodes =="
# The case that should be invisible: different node ids hash to different
# shards, so the two commits touch disjoint paths and there is nothing to
# resolve. This is where all the merge smoothness actually comes from.
fresh_checkout -b branch-a
summarise a 'rs1:r:func:m.py#f@0' 'A: returns one' "$FH" '2026-08-20T10:00:00Z'
commit "summarise f"
SHARD_A=$(shard_holding 'A: returns one')

fresh_checkout "$MAIN"
fresh_checkout -b branch-b
summarise b 'rs1:r:func:m.py#g@0' 'B: returns two' "$GH" '2026-08-20T11:00:00Z'
commit "summarise g"
SHARD_B=$(shard_holding 'B: returns two')

[ -n "$SHARD_A" ] && [ -n "$SHARD_B" ] || fail "a branch committed no shard at all"
[ "$SHARD_A" != "$SHARD_B" ] || fail "both branches wrote $SHARD_A — the shard spread is broken"
echo "   branch-a wrote $SHARD_A"
echo "   branch-b wrote $SHARD_B"

git checkout -q branch-a
merge branch-b || fail "unrelated summaries conflicted"
grep -qr 'A: returns one' .reposkein/summaries/ || fail "branch-a's prose lost in the merge"
grep -qr 'B: returns two' .reposkein/summaries/ || fail "branch-b's prose lost in the merge"
echo "PASS clean merge, both summaries survive"

# ---------------------------------------------------------------------------
echo
echo "== two branches summarise the SAME node =="
# The unavoidable case. Both branches write the same shard with different
# content. What must hold: the index never fails, the shard comes out canonical
# and marker-free, the winner is the same on every machine, and the loser is
# preserved somewhere a human can read it.
git checkout -qb branch-c
summarise c 'rs1:r:func:m.py#f@0' 'C: the constant one' "$FH" '2026-08-21T09:00:00Z'
commit "resummarise f (C)"

git checkout -q branch-a
git checkout -qb branch-d
summarise d 'rs1:r:func:m.py#f@0' 'D: the identity of one' "$FH" '2026-08-22T09:00:00Z'
commit "resummarise f (D)"

# May or may not conflict: .reposkein/.gitattributes declares merge=union, and
# git honours it HERE because this is a worktree. A forge would not — which is
# why the reader below has to cope either way.
merge branch-c || echo "   (git left conflict markers; the reader must handle it)"
echo "   shard as git left it:"
sed 's/^/     /' .reposkein/summaries/*.jsonl | cut -c1-96

idx
echo "   shard after index:"
sed 's/^/     /' .reposkein/summaries/*.jsonl | cut -c1-96

grep -qr '<<<<<<<\|>>>>>>>' .reposkein/summaries/ && fail "conflict markers survived the index"
[ "$(cat .reposkein/summaries/*.jsonl | grep -c 'm.py#f@0')" = "1" ] \
  || fail "the node ended up on more than one line"
grep -qr 'D: the identity of one' .reposkein/summaries/ \
  || fail "the newer summary_at did not win"
grep -q 'C: the constant one' .reposkein/local/conflicts.jsonl \
  || fail "the losing record was destroyed instead of preserved"

echo "PASS shard rewritten clean, newer record wins, loser preserved in local/conflicts.jsonl"
echo
echo "repro repo left at $WORK"
