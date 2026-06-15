from track2.config import AgentConfig
from track2.llm import MockLLM
from track2.loop import run_agent
from track2.tools.base import FuncTool


def _tool(calls):
    return FuncTool(
        "edit_file", "edit", {"type": "object", "properties": {}},
        lambda a: calls.append(a) or "edited x.py",
    )


def test_loop_runs_tool_then_finishes():
    calls = []
    script = [
        [{"type": "tool_use", "id": "t1", "name": "edit_file", "input": {"path": "x.py"}}],
        [{"type": "text", "text": "done"}],
    ]
    res = run_agent(MockLLM(script), "sys", "fix the bug", [_tool(calls)], AgentConfig(max_turns=5))
    assert res.turns == 2
    assert res.stop == "done"
    assert calls == [{"path": "x.py"}]
    assert res.total_tokens == 30  # 2 turns * (10 in + 5 out)


def test_loop_hits_max_turns():
    script = [[{"type": "tool_use", "id": f"t{i}", "name": "edit_file", "input": {}}] for i in range(3)]
    res = run_agent(MockLLM(script), "sys", "loop", [_tool([])], AgentConfig(max_turns=3))
    assert res.turns == 3 and res.stop == "max_turns"


def test_unknown_tool_is_reported_not_fatal():
    script = [
        [{"type": "tool_use", "id": "t1", "name": "nope", "input": {}}],
        [{"type": "text", "text": "ok"}],
    ]
    res = run_agent(MockLLM(script), "sys", "t", [_tool([])], AgentConfig(max_turns=5))
    assert res.stop == "done"
    # the tool_result content carried the unknown-tool error back to the model
    last_user = [m for m in res.transcript if m["role"] == "user"][-1]
    assert "unknown tool" in last_user["content"][0]["content"]
