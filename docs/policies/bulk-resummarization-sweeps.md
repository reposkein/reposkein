# Policy: bulk re-summarization sweeps run serialized on `main`

Status: active.
Written: 2026-08-20.
Applies to: any repository committing `.reposkein/summaries/`.

## The rule

**A sweep that rewrites summaries in bulk runs as a single serialized job on `main`, never from a feature branch, and never two at once.**

Everything else about summaries is designed to need no coordination. This one workload is the exception, and it is worth stating so nobody discovers it the hard way.

## Why sharding does not cover this case

`.reposkein/summaries/<xx>.jsonl` shards by `BLAKE3(node_id)`, up to 256 files. The design assumption is that a branch writes summaries for the handful of nodes it touched, so two branches land in different shards and their commits touch disjoint paths — a forge has nothing to conflict on.

A sweep breaks that assumption directly. Re-summarizing a whole repository writes to *every* shard, so it collides with every other branch that wrote a single summary. The granularity that makes normal work smooth does nothing when one commit touches all 256 files.

The conflict is also not the interesting failure. The interesting one is loss. Two sweeps running concurrently — say a nightly job and someone re-running it by hand — each read the shards, each fold in their own results, and each write back. Whichever lands second wins, and the first sweep's work is gone. It will not error. The deterministic tiebreak (newer `summary_at`, then raw-line byte order) resolves *merge* divergence correctly, but it cannot recover a record that was overwritten before the merge ever happened.

## What a sweep must do

1. **Run on `main`, from a job with exclusive access.** In GitHub Actions that is `concurrency: { group: reposkein-summary-sweep, cancel-in-progress: false }`. `cancel-in-progress: false` matters: cancelling a half-finished sweep is how you get a partial rewrite.
2. **Re-index first, sweep second, commit third.** `reposkein-indexer index .` folds in every pending sidecar before the sweep starts, so the sweep does not race with prose an agent session wrote but never indexed.
3. **Commit only `.reposkein/summaries/`.** Never `git add -A` in a sweep job.
4. **Push directly, or open one pull request and merge it immediately.** A sweep PR left open for review conflicts with every other branch, every day, for as long as it is open — the exact cost the sharding exists to avoid. Do not reintroduce it by holding the sweep in review.
5. **Read `.reposkein/local/conflicts.jsonl` afterwards.** If the sweep produced divergence losers, a human should see them before they are forgotten. `reposkein-mcp doctor` reports the count.

## What a sweep must not do

- Run from a long-lived branch.
- Run in parallel with another sweep, on any branch.
- Ride along in an unrelated pull request.
- Be triggered per-commit. Sweeps are periodic maintenance, not a hook.

## What still needs no coordination

Everything normal: an agent writing a summary during a session, a developer committing a handful of shards, two people on different branches summarising different code, a `git pull` that brings in a teammate's shards. Those are what the design is for, and they need no policy at all.

## Related

- `docs/INSTALL.md` §4.2 — the merge model in full.
- `docs/migrations/2026-08-06-stop-committing-derived-graph.md` — why forge-side merges cannot be fixed with `.gitattributes`, which is what forced file granularity.

