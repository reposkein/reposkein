from pathlib import Path
from track2.arms.grep_arm import build_grep_tools


def test_grep_arm_finds_match(tmp_path: Path):
    (tmp_path / "m.py").write_text("def widget():\n    return 42\n")
    tools = {t.name: t for t in build_grep_tools(tmp_path, "pytest -q")}
    out = tools["ripgrep_search"].run({"pattern": "widget"})
    assert "m.py" in out and "widget" in out
    assert "m.py" in tools["find_files"].run({"glob": "*.py"})
    # arm exposes navigation + the 3 common tools
    assert set(tools) == {"ripgrep_search", "find_files", "read_file", "edit_file", "run_tests"}
