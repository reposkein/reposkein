# Migration: stop committing the derived RepoSkein graph

For humans. Historical — describes a past migration; the single-file
`summaries.jsonl` it introduces below was itself later replaced by sharded
`summaries/<xx>.jsonl` (see [`../INSTALL.md` §4.2](../INSTALL.md#42-merge-behaviour-for-reposkein)
for the current scheme and the follow-up migration off this file).

Status: plan only. Nothing here has been executed.
Written: 2026-08-06.
Applies to: any repository that already has `.reposkein/nodes.jsonl` and
`.reposkein/edges.jsonl` under version control.

## What changed upstream

`nodes.jsonl` and `edges.jsonl` are now treated as derived output. `reposkein-indexer index`
writes a `.reposkein/.gitignore` covering them, the `pre-commit` hook no longer stages anything,
and the MCP server builds the graph on startup when it is missing. Authored semantic summaries
move to `.reposkein/summaries.jsonl`, which is small, rarely written, and meant to be committed.

Nothing about the graph's content or determinism changed. The same index of the same tree
produces the same bytes as before.

## Why

Three measured problems, all caused by the files being in git rather than by anything in the
graph itself.

1. **Phantom merge conflicts.** The pre-commit hook re-indexed and staged on every commit, so
   every branch modified both files. The moment any pull request merged, every other open one
   reported `CONFLICTING`. Four separate occurrences were measured in `cellarnode-backend-v2` on
   2026-08-06; every rebase applied with zero conflict markers, so no human judgement was ever
   involved.

2. **A merge driver cannot fix it.** Forges compute mergeability in a bare repository, and git
   does not consult a tree-level `.gitattributes` when there is no worktree. Verified with
   `git merge-tree --write-tree` against a bare clone: `git check-attr merge` reports `union` in
   a worktree and `unspecified` in the bare repo, and the merge exits 1 with conflict markers.
   Injecting the same rule into the bare repo's `info/attributes` makes it apply, which confirms
   attribute lookup, not driver availability, is the mechanism. This defeats the custom
   `reposkein-jsonl` driver and the built-in `merge=union` alike.

3. **Union merge corrupts the graph where it does apply.** Union keeps both sides' lines, so a
   node both branches touched ends up on two lines with the same `id` and different bodies. A
   reader taking the last match sees a stale node shape. Forty duplicate ids were observed after
   one rebase in `cellarnode-backend-v2`, invisible to `git diff --name-only` because the
   pre-commit hook re-snapshots the pre-rebase tree.

Two further findings from the investigation:

4. **The committed graph bought nothing in practice.** Across all 16 CellarNode repositories:
   29,605 committed nodes, **zero** carrying a `semantic_summary`, 18.1 MB of machine-generated
   JSONL under version control. The one thing committing was supposed to preserve was never
   present.

5. **The committed graph was already wrong.** At `cellarnode-backend-v2` HEAD, the committed
   `nodes.jsonl` held 8,109 lines while a fresh index of the same tree with the same indexer
   produced 10,257 nodes (edges 13,122 against 17,454). Roughly 21 percent stale, so the hook
   was not in fact keeping it in sync.

The cost of removing them is small: a cold full index of `cellarnode-backend-v2` (1,896 files,
10,257 nodes, 17,454 edges) takes **2.04s** wall clock; a warm one 0.37s. Building on first query
is cheaper than the conflict tax, and the server logs a line explaining the wait.

## Blast radius

Per repository, three tracked paths change:

| Path | Before | After |
|---|---|---|
| `.reposkein/nodes.jsonl` | tracked | untracked, git-ignored |
| `.reposkein/edges.jsonl` | tracked | untracked, git-ignored |
| `.reposkein/.gitignore` | absent or `local/` only | adds `nodes.jsonl`, `edges.jsonl` |
| `.gitattributes` | may hold `merge=reposkein-jsonl` or `merge=union` lines | those lines removed |
| `.reposkein/meta.json`, `config.toml` | tracked | unchanged, still tracked |
| `.reposkein/summaries.jsonl` | did not exist | tracked once an agent writes a summary |

Nothing outside `.reposkein/` and `.gitattributes` is touched.

## Prerequisites

1. The upstream change is merged and released, and `@reposkein/mcp` is upgraded on every machine
   that will run an index. A machine still on the old indexer will re-create the tracked files on
   its next commit and undo the migration for that branch.
2. Every open pull request in the repository is merged or rebased onto the migrated `main`. A
   branch that still has the files tracked will conflict with the removal exactly once. This is
   the last conflict the migration causes and it is unavoidable.
3. Announce a window. The migration is a one-commit change per repository, but it lands in
   everyone's working tree at once.

## Per-repository steps

Run inside each repository, on a branch, one pull request per repository.

```sh
# 1. Refresh .reposkein/ with the new indexer so .gitignore and summaries.jsonl are written.
reposkein-mcp index .

# 2. Untrack the derived files. --cached keeps them on disk, so nothing needs re-indexing.
git rm --cached .reposkein/nodes.jsonl .reposkein/edges.jsonl

# 3. Drop any merge declaration for them. `reposkein-mcp init` does this, or by hand:
#    remove the two `.reposkein/*.jsonl merge=...` lines from .gitattributes,
#    and delete the file if it held nothing else.
reposkein-mcp init .

# 4. Stage explicitly. Never `git add -A` here: step 1 may have refreshed a stale graph,
#    and those changes are exactly what we are trying to stop committing.
git add .reposkein/.gitignore
git add .gitattributes 2>/dev/null || true      # only if it still exists
git add .reposkein/summaries.jsonl 2>/dev/null || true

# 5. Verify before committing. Expect: two deletions, one .gitignore, and nothing else.
git status --short
git diff --cached --stat

git commit -m "chore: stop tracking the derived RepoSkein graph"
```

Expected `git diff --cached --stat`: two deleted `.jsonl` files with a large line count, one
small `.gitignore`, optionally a small `.gitattributes` and `summaries.jsonl`. Anything else in
that list means step 4 over-staged; unstage it rather than committing.

### Verification after merge

```sh
git ls-files .reposkein            # must not list nodes.jsonl or edges.jsonl
git check-ignore -v .reposkein/nodes.jsonl   # must report .reposkein/.gitignore
reposkein-mcp doctor .             # must still report ✓ indexed (N nodes)
```

Then confirm a clone works from nothing:

```sh
git clone <repo> /tmp/migrate-check && cd /tmp/migrate-check
reposkein-mcp doctor .             # expect ✗ indexed, since a clone has no derived graph
reposkein-mcp index .              # expect it to build in seconds
reposkein-mcp doctor .             # expect ✓ indexed
```

## What breaks for a contributor who pulls mid-migration

The failure modes are mild and all self-correct, but they should be in the announcement.

**A contributor with local changes to the tracked files.** `git pull` will refuse or conflict,
because the migration deletes files their working tree has modified. Resolution: accept the
deletion. The file content is derived, so nothing is lost. Do not resolve by keeping the local
copy, which re-tracks it.

**A contributor on a branch created before the migration.** Their branch still tracks both files.
Rebasing onto migrated `main` produces one conflict per file, resolved by taking the deletion:

```sh
git rebase origin/main
git rm --cached .reposkein/nodes.jsonl .reposkein/edges.jsonl
git rebase --continue
```

**A contributor still running the old indexer.** Their `pre-commit` hook will `git add` the two
files again, silently re-tracking them on their next commit. This is the one failure that does
not self-correct, and it is why the version prerequisite is not optional. It shows up as the
files reappearing in `git status` on someone else's machine. Fix: upgrade, then
`git rm --cached` them again.

**A contributor whose git config still has the custom merge driver registered.** Harmless. The
`merge-jsonl` subcommand is deliberately retained upstream, so a stale
`merge.reposkein-jsonl.driver` entry still resolves to a working binary. `reposkein-mcp init`
unsets it. Nothing breaks if they never run it.

**An agent session mid-flight when the migration lands.** If an agent wrote summaries that are
still only in `.reposkein/local/summaries.jsonl`, the next `index` folds them into
`summaries.jsonl` as normal. Summaries that were already inside a committed `nodes.jsonl` are
harvested by the first index after the upgrade, so the upgrade itself loses nothing. But once
`nodes.jsonl` is untracked, a summary that never made it into `summaries.jsonl` exists only on
that one machine. Ask contributors to run `reposkein-mcp index .` and commit any resulting
`summaries.jsonl` **before** the migration commit lands.

**CI that reads the committed graph.** Nothing in the CellarNode repositories does this today
(checked: no workflow references `.reposkein`). If a repository adds such a step later, it needs
a `reposkein-mcp index .` before whatever consumes the graph.

## The 16 CellarNode repositories

All 16 currently have both files committed. Listed with their committed node counts, largest
first, since the largest are where the conflict pain was measured and where the migration is
most worth doing early.

| Repository | Nodes | Edges |
|---|---:|---:|
| `cellarnode-backend-v2` | 8109 | 13122 |
| `ui` | 5602 | 8894 |
| `cellarnode-admin-dashboard-v2` | 2645 | 3630 |
| `producer-dashboard` | 2595 | 4136 |
| `cellarnode-importer-dashboard` | 1234 | 1608 |
| `cellarnode-public-site` | 1223 | 1447 |
| `bottle_extractor` | 999 | 1905 |
| `crossplane-gcloud` | 400 | 408 |
| `cellarnode-elabel-frontend` | 327 | 455 |
| `project-match` | 127 | 159 |
| `beverage-utils` | 115 | 155 |
| `cellarnode-mobile-app` | 99 | 104 |
| `cellarnode-auth` | 89 | 127 |
| `polyglot-i18n` | 80 | 133 |
| `finance` | 66 | 95 |
| `cellarnode-i18n` | 54 | 68 |

Suggested order: migrate `cellarnode-backend-v2` and `ui` first. They have the most branches in
flight and therefore the most conflicts to stop, and they are the two that will prove the
approach. The remaining 14 can go in a single batch afterwards.

## Documentation that needs a separate change

`/Users/mjnong/REPOS/CellarNode/CLAUDE.md` currently states, in its RepoSkein file map:

> `.reposkein/nodes.jsonl`, `edges.jsonl` | Canonical deterministic graph. Commit these.

That line is the opposite of the new behaviour and will keep agents re-adding the files. The
same file's "Operational notes" section describes the merge driver setup and tells new
contributors to run `reposkein-mcp init` to register it, which also needs revising: `init` now
removes that registration rather than adding it.

Those edits are outside this repository and are not part of this plan. They are flagged here so
they are not missed.
