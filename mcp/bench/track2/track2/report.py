"""Aggregate a Track 2 markdown report: resolve-rate + tokens + turns per arm."""
from __future__ import annotations
from typing import Any
from .swebench.runner import InstancePrediction


def build_report(
    arm: str, preds: list[InstancePrediction], swe_report: dict[str, Any] | None
) -> str:
    n = len(preds)
    resolved_ids: set[str] = set()
    if swe_report:
        # swebench 4.1.0 report uses "resolved_ids" key (verified in reporting.py).
        resolved_ids = set(swe_report.get("resolved_ids") or swe_report.get("resolved") or [])
    resolved = sum(1 for p in preds if p.instance_id in resolved_ids)
    nonerr = [p for p in preds if not p.stop.startswith("error")]
    mean_tok = sum(p.total_tokens for p in nonerr) / max(1, len(nonerr))
    mean_turns = sum(p.turns for p in nonerr) / max(1, len(nonerr))
    pct = (100 * resolved / n) if n else 0.0
    lines = [
        f"## Track 2 — arm `{arm}` ({n} instances)",
        "",
        "| metric | value |",
        "|---|---|",
        f"| resolve-rate (pass@1) | {resolved}/{n} ({pct:.0f}%) |",
        f"| mean total tokens | {mean_tok:,.0f} |",
        f"| mean turns | {mean_turns:.1f} |",
        f"| errored instances | {n - len(nonerr)} |",
    ]
    return "\n".join(lines)
