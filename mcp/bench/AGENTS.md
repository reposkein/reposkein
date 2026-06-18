# mcp/bench/

Two benchmark tracks. **Excluded from the npm tarball** (not in `package.json.files`, not in `tsconfig.include`).

## TRACK 1 — retrieval efficiency (TypeScript, deterministic, in CI gates)

```
bench/run.ts                       # harness entry
bench/fixtures/reposkein.json      # HAND-LABELED ground truth (NOT generated from RepoSkein)
```

Run: `npm run bench -- /path/to/indexed/repo` (requires `rg` on PATH + a committed `.reposkein/`).

Compares RepoSkein's `get_context_profile` arm vs a grep arm on `callers` / `callees` / `lookup` tasks. Scoring = **F0.5** (precision-weighted, β=0.5). Token cost = grep's matched-function-body bytes vs RepoSkein's profile JSON length / 4.

The grep arm **excludes** `.reposkein/`, `target/`, `node_modules/`, `dist/`, and `bench/` itself (so grep isn't penalised for matching the fixtures/README).

## TRACK 2 — end-task (Python pytest harness, opt-in, NOT in CI)

```
track2/
  pyproject.toml        # ruff line-length=100, requires-python>=3.11
  track2/run.py         # entry
  track2/{config,llm,loop,report}.py
  track2/arms/          # RepoSkein vs grep retrieval toolsets
  track2/tools/         # tool wrappers the agent loop calls
  track2/swebench/      # SWE-bench-Verified dataset adapter
  tests/                # pytest validation (CI-able, mock LLM)
```

Local validation: `cd mcp/bench/track2 && python -m pytest`. Full eval requires an Anthropic API key + Docker (each task gets a sandboxed container) — intentionally outside CI.

## CONVENTIONS

- **Ground-truth is hand-labeled**, NOT machine-generated. Read source, grep call sites manually. Using RepoSkein's own output as GT invalidates the benchmark.
- Track 1 reports **two** token models (`fns` = generous to grep, `files` = upper bound). The headline ratio uses `fns` — never inflate the comparison.
- Track 2's `predictions*.jsonl` / `run_results/` / `logs/` / `.venv/` are gitignored in `mcp/.gitignore`. Don't check them in.

## ANTI-PATTERNS

- Removing `bench/` from the grep arm exclusion list — grep would match the fixtures' own query terms.
- Adding a unit test under `test/` for `bench/` code — bench is dev tooling, not product code. Track 2 tests live in `track2/tests/`.
- Importing from `bench/` inside `src/` — bench would be pulled into the npm tarball.
- Editing `pyproject.toml` to relax `requires-python` below 3.11 — modern type hints break on older Python.
