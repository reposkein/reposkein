"""Prepare a clean working tree for the agent: clone <repo> @ base_commit."""
from __future__ import annotations
import subprocess
from pathlib import Path
from typing import Any


def prepare_workdir(instance: dict[str, Any], root: Path) -> Path:
    repo = instance["repo"]  # e.g. "astropy/astropy"
    dest = root / instance["instance_id"]
    if dest.exists():
        subprocess.run(["rm", "-rf", str(dest)], check=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{repo}.git"
    subprocess.run(["git", "clone", "--quiet", url, str(dest)], check=True)
    subprocess.run(["git", "checkout", "--quiet", instance["base_commit"]], cwd=dest, check=True)
    return dest


def capture_patch(workdir: Path) -> str:
    """Unified diff of the agent's edits vs base_commit (the model_patch)."""
    proc = subprocess.run(
        ["git", "diff"], cwd=workdir, capture_output=True, text=True, check=True
    )
    return proc.stdout
