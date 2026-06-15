from pathlib import Path
from track2.tools.base import FuncTool, to_anthropic_specs
from track2.tools.common import common_tools, make_edit_file, make_read_file


def test_functool_runs_and_catches():
    t = FuncTool("echo", "echo", {"type": "object", "properties": {}}, lambda a: a["x"])
    assert t.run({"x": "hi"}) == "hi"
    assert t.run({}).startswith("ERROR: KeyError")


def test_to_anthropic_specs_shape():
    t = FuncTool("n", "d", {"type": "object", "properties": {}}, lambda a: "")
    spec = to_anthropic_specs([t])[0]
    assert spec["name"] == "n" and "input_schema" in spec


def test_read_and_edit(tmp_path: Path):
    (tmp_path / "a.py").write_text("def f():\n    return 1\n")
    rd = make_read_file(tmp_path)
    assert "return 1" in rd.run({"path": "a.py"})
    ed = make_edit_file(tmp_path)
    assert ed.run({"path": "a.py", "old_str": "return 1", "new_str": "return 2"}).startswith("edited")
    assert "return 2" in (tmp_path / "a.py").read_text()


def test_edit_ambiguous(tmp_path: Path):
    (tmp_path / "a.py").write_text("x\nx\n")
    ed = make_edit_file(tmp_path)
    assert "matches 2 times" in ed.run({"path": "a.py", "old_str": "x", "new_str": "y"})


def test_path_escape_blocked(tmp_path: Path):
    rd = make_read_file(tmp_path)
    assert rd.run({"path": "../../etc/passwd"}).startswith("ERROR")


def test_run_tests_restricted(tmp_path: Path):
    tools = {t.name: t for t in common_tools(tmp_path, "pytest -q")}
    assert tools["run_tests"].run({"command": "rg secret"}).startswith("ERROR")
