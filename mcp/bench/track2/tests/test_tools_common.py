from track2.tools.base import FuncTool, to_anthropic_specs


def test_functool_runs_and_catches():
    t = FuncTool("echo", "echo", {"type": "object", "properties": {}}, lambda a: a["x"])
    assert t.run({"x": "hi"}) == "hi"
    assert t.run({}).startswith("ERROR: KeyError")


def test_to_anthropic_specs_shape():
    t = FuncTool("n", "d", {"type": "object", "properties": {}}, lambda a: "")
    spec = to_anthropic_specs([t])[0]
    assert spec["name"] == "n" and "input_schema" in spec
