"""Write predictions.jsonl and run the official swebench evaluation harness.
The eval needs Docker + is user-side. Report filename/flags: VERIFIED against
swebench==4.1.0. The report file is named <model_name_or_path with /->__>.<run_id>.json
and written to --report_dir (default: CWD). The resolved_ids key exists in the report.

Prediction keys (verified from swebench.harness.constants):
  KEY_INSTANCE_ID = "instance_id"
  KEY_MODEL       = "model_name_or_path"
  KEY_PREDICTION  = "model_patch"
"""
from __future__ import annotations
import json
import subprocess
from pathlib import Path
from typing import Any
from .runner import InstancePrediction


def write_predictions(preds: list[InstancePrediction], path: Path) -> None:
    with path.open("w") as f:
        for p in preds:
            f.write(json.dumps({
                "instance_id": p.instance_id,
                "model_name_or_path": p.model_name_or_path,
                "model_patch": p.model_patch,
            }) + "\n")


def run_evaluation(predictions_path: Path, run_id: str, max_workers: int = 4) -> dict[str, Any]:
    """Shell out to swebench (swebench==4.1.0). Flags verified against run_evaluation.py argparse.
    The report is written as <model_name_or_path (/ -> __)>.<run_id>.json in the CWD."""
    subprocess.run(
        [
            "python", "-m", "swebench.harness.run_evaluation",
            "--dataset_name", "princeton-nlp/SWE-bench_Verified",
            "--predictions_path", str(predictions_path),
            "--max_workers", str(max_workers),
            "--run_id", run_id,
        ],
        check=True,
    )
    # swebench 4.1.0 writes <model_name_or_path with /->__>.<run_id>.json in CWD.
    candidates = sorted(Path.cwd().glob(f"*{run_id}*.json"))
    if not candidates:
        raise RuntimeError(f"no swebench report matching *{run_id}*.json in {Path.cwd()}")
    return json.loads(candidates[-1].read_text())
