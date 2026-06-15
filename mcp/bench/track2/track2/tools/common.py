"""Common tools shared by every arm: read a file slice, apply an exact-string
edit, and run the repo's test command. Deliberately NO general shell — that
would let either arm substitute for the other's navigation strategy."""
from __future__ import annotations
import subprocess
from pathlib import Path
from .base import FuncTool, Tool


def _safe_path(workdir: Path, rel: str) -> Path:
    p = (workdir / rel).resolve()
    if not str(p).startswith(str(workdir.resolve())):
        raise ValueError(f"path escapes workdir: {rel}")
    return p


def make_read_file(workdir: Path) -> Tool:
    def run(a: dict) -> str:
        p = _safe_path(workdir, a["path"])
        text = p.read_text(encoding="utf-8", errors="replace")
        lines = text.split("\n")
        start = max(1, int(a.get("start_line", 1)))
        end = min(len(lines), int(a.get("end_line", len(lines))))
        slice_ = lines[start - 1 : end]
        return "\n".join(f"{start + i}\t{ln}" for i, ln in enumerate(slice_))

    return FuncTool(
        "read_file",
        "Read a file (optionally a line range) from the working tree. Returns numbered lines.",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to repo root"},
                "start_line": {"type": "integer"},
                "end_line": {"type": "integer"},
            },
            "required": ["path"],
        },
        run,
    )


def make_edit_file(workdir: Path) -> Tool:
    def run(a: dict) -> str:
        p = _safe_path(workdir, a["path"])
        old, new = a.get("old_str", ""), a["new_str"]
        if a.get("create"):
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(new, encoding="utf-8")
            return f"created {a['path']}"
        text = p.read_text(encoding="utf-8")
        count = text.count(old)
        if count == 0:
            return "ERROR: old_str not found (must match exactly, including whitespace)"
        if count > 1:
            return f"ERROR: old_str matches {count} times; make it unique"
        p.write_text(text.replace(old, new, 1), encoding="utf-8")
        return f"edited {a['path']}"

    return FuncTool(
        "edit_file",
        "Replace an exact unique string in a file, or create a new file (create=true uses new_str as full contents).",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_str": {"type": "string"},
                "new_str": {"type": "string"},
                "create": {"type": "boolean"},
            },
            "required": ["path", "new_str"],
        },
        run,
    )


def make_run_tests(workdir: Path, test_cmd: str) -> Tool:
    def run(a: dict) -> str:
        cmd = a.get("command") or test_cmd
        # Only the configured test command (or its prefix) is allowed.
        if not cmd.startswith(test_cmd.split()[0]):
            return f"ERROR: only the test runner ({test_cmd.split()[0]}) is allowed here"
        proc = subprocess.run(
            cmd, shell=True, cwd=workdir, capture_output=True, text=True, timeout=600
        )
        out = (proc.stdout + "\n" + proc.stderr)[-8000:]
        return f"exit={proc.returncode}\n{out}"

    return FuncTool(
        "run_tests",
        f"Run the project's test command (default: `{test_cmd}`) in the repo. Returns exit code + last 8KB of output.",
        {
            "type": "object",
            "properties": {"command": {"type": "string", "description": f"Defaults to `{test_cmd}`"}},
        },
        run,
    )


def common_tools(workdir: Path, test_cmd: str) -> list[Tool]:
    return [make_read_file(workdir), make_edit_file(workdir), make_run_tests(workdir, test_cmd)]
