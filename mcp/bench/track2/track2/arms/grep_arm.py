"""Arm B — grep baseline. Navigation = ripgrep + find; shares common tools."""
from __future__ import annotations
from pathlib import Path
from ..tools.base import Tool
from ..tools.common import common_tools
from ..tools.grep import make_find_files, make_ripgrep_search


def build_grep_tools(workdir: Path, test_cmd: str) -> list[Tool]:
    return [make_ripgrep_search(workdir), make_find_files(workdir), *common_tools(workdir, test_cmd)]
