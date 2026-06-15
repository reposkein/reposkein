"""Track 2 CLI.

Examples:
  # Generate patches with the RepoSkein arm (needs ANTHROPIC_API_KEY):
  python -m track2.run --arm reposkein --slice 10 --predictions-only
  # Then grade them (needs Docker):
  python -m track2.run --arm reposkein --slice 10 --evaluate \
      --predictions predictions-reposkein.jsonl
"""
from __future__ import annotations
import argparse
from pathlib import Path
from .config import AgentConfig
from .llm import AnthropicLLM
from .swebench.slice import load_slice
from .swebench.runner import run_slice
from .swebench.evaluate import write_predictions, run_evaluation
from .report import build_report


def main() -> int:
    ap = argparse.ArgumentParser(prog="track2")
    ap.add_argument("--arm", choices=["reposkein", "grep"], required=True)
    ap.add_argument("--slice", type=int, default=10)
    ap.add_argument("--repo", default=None, help="restrict to one repo (e.g. astropy/astropy)")
    ap.add_argument("--model", default="claude-sonnet-4-6")
    ap.add_argument("--max-turns", type=int, default=40)
    ap.add_argument("--workdir-root", default="run_results/checkouts")
    ap.add_argument("--predictions", default=None)
    ap.add_argument("--predictions-only", action="store_true", help="run agent, write preds, skip Docker eval")
    ap.add_argument("--evaluate", action="store_true", help="run swebench Docker eval on existing/just-made preds")
    ap.add_argument("--max-workers", type=int, default=4)
    args = ap.parse_args()

    cfg = AgentConfig(model=args.model, max_turns=args.max_turns)
    preds_path = Path(args.predictions or f"predictions-{args.arm}.jsonl")
    run_id = f"track2-{args.arm}-{args.slice}"

    instances = load_slice(args.slice, args.repo)
    print(f"[track2] {len(instances)} instances, arm={args.arm}")

    # Agent phase (skipped if only re-evaluating existing predictions)
    if not (args.evaluate and preds_path.exists() and not args.predictions_only):
        llm = AnthropicLLM(cfg.model, cfg.max_tokens, cfg.temperature)
        preds = run_slice(instances, args.arm, llm, cfg, Path(args.workdir_root))
        write_predictions(preds, preds_path)
        print(f"[track2] wrote {preds_path}")
    else:
        preds = []  # re-eval path doesn't have harness-side metrics; report resolve-rate only

    swe_report = None
    if args.evaluate:
        swe_report = run_evaluation(preds_path, run_id, args.max_workers)

    if preds:
        print("\n" + build_report(args.arm, preds, swe_report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
