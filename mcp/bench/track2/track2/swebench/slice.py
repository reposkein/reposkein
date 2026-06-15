"""Load a deterministic slice of SWE-bench-Verified."""
from __future__ import annotations
from typing import Any


def load_slice(n: int, repo_filter: str | None = None) -> list[dict[str, Any]]:
    from datasets import load_dataset

    ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
    rows = [dict(r) for r in ds]
    if repo_filter:
        rows = [r for r in rows if r["repo"] == repo_filter]
    rows.sort(key=lambda r: r["instance_id"])  # deterministic
    return rows[:n]
