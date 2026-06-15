"""Per-instance + slice runner. Builds the arm's tools, runs the agent on the
problem statement, captures the git diff as the model_patch."""
from __future__ import annotations
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any
from ..config import AgentConfig
from ..llm import LLM
from ..loop import run_agent, AgentResult
from ..arms.grep_arm import build_grep_tools
from ..arms.reposkein_arm import RepoSkeinArm
from .checkout import prepare_workdir, capture_patch

SYSTEM_PROMPT = (
    "You are an autonomous software engineer fixing a real GitHub issue in a repository. "
    "Investigate the codebase, make a minimal correct change, and verify it. "
    "When you are confident the fix is complete, stop. Do not ask questions."
)

TASK_TEMPLATE = (
    "Repository: {repo}\n\n"
    "Resolve the following issue by editing the code. The repo is checked out at the "
    "buggy commit in your working directory.\n\n--- ISSUE ---\n{problem}\n--- END ISSUE ---"
)


@dataclass
class InstancePrediction:
    instance_id: str
    model_name_or_path: str
    model_patch: str
    turns: int
    total_tokens: int
    stop: str


def _build_tools(arm: str, workdir: Path, test_cmd: str):
    """Returns (tools, context_manager_or_None). RepoSkein arm needs a CM."""
    if arm == "grep":
        return build_grep_tools(workdir, test_cmd), None
    if arm == "reposkein":
        cm = RepoSkeinArm(workdir, test_cmd)
        return None, cm
    raise ValueError(f"unknown arm: {arm}")


def run_instance(
    instance: dict[str, Any], arm: str, llm: LLM, cfg: AgentConfig, root: Path
) -> InstancePrediction:
    workdir = prepare_workdir(instance, root)
    task = TASK_TEMPLATE.format(repo=instance["repo"], problem=instance["problem_statement"])
    test_cmd = "python -m pytest -q"  # SWE-bench Python repos; grading uses swebench's own cmd

    if arm == "reposkein":
        with RepoSkeinArm(workdir, test_cmd) as tools:
            res = run_agent(llm, SYSTEM_PROMPT, task, tools, cfg)
    else:
        tools, _ = _build_tools(arm, workdir, test_cmd)
        res = run_agent(llm, SYSTEM_PROMPT, task, tools, cfg)

    return InstancePrediction(
        instance_id=instance["instance_id"],
        model_name_or_path=f"reposkein-track2-{arm}",
        model_patch=capture_patch(workdir),
        turns=res.turns,
        total_tokens=res.total_tokens,
        stop=res.stop,
    )


def run_slice(
    instances: list[dict[str, Any]], arm: str, llm: LLM, cfg: AgentConfig, root: Path
) -> list[InstancePrediction]:
    preds = []
    for inst in instances:
        try:
            preds.append(run_instance(inst, arm, llm, cfg, root))
        except Exception as e:  # one bad instance shouldn't kill the slice
            preds.append(
                InstancePrediction(inst["instance_id"], f"reposkein-track2-{arm}", "", 0, 0, f"error: {e}")
            )
    return preds
