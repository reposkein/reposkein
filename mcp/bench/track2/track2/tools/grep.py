"""Grep-arm navigation: ripgrep search + file find. Mirrors a Claude-Code-style
lexical search stack. Resolves the real rg binary (not a shell alias)."""
from __future__ import annotations
import shutil
import subprocess
from pathlib import Path
from .base import FuncTool, Tool

_RG_CANDIDATES = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]


def resolve_rg() -> str:
    for c in _RG_CANDIDATES:
        if Path(c).exists():
            return c
    found = shutil.which("rg")
    if found:
        return found
    raise RuntimeError("ripgrep (rg) not found; `brew install ripgrep`")


def make_ripgrep_search(workdir: Path) -> Tool:
    rg = resolve_rg()

    def run(a: dict) -> str:
        args = [rg, "-n", "--no-heading", "--color=never", "-g", "!.reposkein", "-g", "!.git"]
        if a.get("glob"):
            args += ["-g", a["glob"]]
        args += [a["pattern"], "."]
        proc = subprocess.run(args, cwd=workdir, capture_output=True, text=True, timeout=60)
        out = (proc.stdout or proc.stderr)[:8000]
        return out or "(no matches)"

    return FuncTool(
        "ripgrep_search",
        "Search file contents with ripgrep. Returns file:line:match. Use `glob` to restrict (e.g. '*.py').",
        {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "glob": {"type": "string", "description": "Optional path glob filter"},
            },
            "required": ["pattern"],
        },
        run,
    )


def make_find_files(workdir: Path) -> Tool:
    rg = resolve_rg()

    def run(a: dict) -> str:
        proc = subprocess.run(
            [rg, "--files", "-g", a["glob"], "-g", "!.git"],
            cwd=workdir, capture_output=True, text=True, timeout=60,
        )
        return (proc.stdout[:8000]) or "(no files)"

    return FuncTool(
        "find_files",
        "List files matching a path glob (e.g. '**/test_*.py').",
        {"type": "object", "properties": {"glob": {"type": "string"}}, "required": ["glob"]},
        run,
    )
