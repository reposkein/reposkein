<div align="center">
<img src="https://capsule-render.vercel.app/api?type=soft&color=0:070A12,50:2DD4BF,100:F2B84B&height=90&section=header&text=End-Task%20Benchmark&fontColor=EAE7DC&fontSize=36" width="100%" alt="RepoSkein end-task benchmark" />

<sub><a href="https://github.com/reposkein/reposkein">← RepoSkein</a> · <a href="https://github.com/reposkein/reposkein#benchmarks">Benchmarks</a> · <a href="../README.md">← Track 1</a></sub>

</div>

# RepoSkein End-Task Benchmark (Track 2)

**Contents:** [Design](#design-one-agent-swap-only-navigation) · [Metrics](#metrics-reported-together-never-one-number) · [Build vs run](#build-vs-run-important) · [How to run](#how-to-run) · [Results](#results)

Track 1 (`mcp/bench/`) measures the **retrieval layer** in isolation. Track 2
measures **end-task outcomes**: does RepoSkein's leaner, structural context let a
real agent resolve SWE-bench-Verified issues with fewer tokens/turns at equal or
better resolve-rate?

## Design: one agent, swap only navigation
- One model, one system+task prompt, one ReAct loop (`track2/loop.py`).
- Shared tools (`read_file`, `edit_file`, constrained `run_tests`) — NO general
  shell, so neither arm can borrow the other's search strategy.
- **Arm A (reposkein):** `get_context_profile` / `read_cypher` / `reindex_file`
  over the checkout indexed in zero-infra JSONL mode (`track2/arms/reposkein_arm.py`).
- **Arm B (grep):** `ripgrep_search` / `find_files` (`track2/arms/grep_arm.py`).

## Metrics (reported together, never one number)
resolve-rate (pass@1, from the official swebench harness) · mean total tokens ·
mean turns.

## Build vs run (important)
- **Built + locally tested (CI-able):** the loop (mock-LLM tests), the tools, the
  grep arm, and the RepoSkein MCP-client smoke (against the built server).
- **User-side (NOT in CI):** the real SWE-bench run. It needs `ANTHROPIC_API_KEY`,
  Docker (the swebench grader), clones public GitHub repos, and **costs real money
  and wall-time** — each instance is up to `--max-turns` model calls × 2 arms.

## How to run
```bash
cd mcp/bench/track2
python3.11 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
pip install -e .
cd ../.. && npm run build && cd bench/track2          # build the MCP server for arm A
python -m pytest                                       # local validation (no network)

export ANTHROPIC_API_KEY=...
python -m track2.run --arm reposkein --slice 10 --predictions-only
python -m track2.run --arm grep       --slice 10 --predictions-only
# grade (needs Docker):
python -m track2.run --arm reposkein --slice 10 --evaluate --predictions predictions-reposkein.jsonl
python -m track2.run --arm grep       --slice 10 --evaluate --predictions predictions-grep.jsonl
```

## swebench version
Pinned to **swebench==4.1.0**. Prediction keys (`instance_id`, `model_name_or_path`,
`model_patch`) and report structure (`resolved_ids` key) verified against this version.
The report file is named `<model_name_or_path (/ -> __)>.<run_id>.json` and written
to the CWD by default (pass `--report_dir` to `run_evaluation` to override).

## Honesty caveats
SWE-bench-Verified repos are mostly small — Augment's analysis shows grep+agent is
competitive there. The honest expectation is a **token/turn win at resolve-rate
parity**, not a resolve-rate blowout. The large-repo regime where structure should
win most (T2-M3) is deferred. Report all three metrics together; never headline
resolve-rate alone.

## Results
_(fill after first run — pinned swebench==4.1.0)_

| arm | instances | resolve-rate | mean tokens | mean turns |
|---|---|---|---|---|
| reposkein | — | — | — | — |
| grep | — | — | — | — |
