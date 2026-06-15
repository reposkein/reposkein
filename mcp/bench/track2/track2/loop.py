"""Minimal ReAct/tool-use loop on the Anthropic Messages API contract.
One model, one prompt; the arm supplies the tool list. Returns usage + turns
+ the final transcript so the runner can capture the patch and metrics."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any
from .config import AgentConfig
from .llm import LLM
from .tools.base import Tool, to_anthropic_specs


@dataclass
class AgentResult:
    turns: int
    input_tokens: int
    output_tokens: int
    stop: str  # "done" | "max_turns"
    transcript: list[dict[str, Any]] = field(default_factory=list)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


def run_agent(llm: LLM, system: str, task: str, tools: list[Tool], cfg: AgentConfig) -> AgentResult:
    by_name = {t.name: t for t in tools}
    specs = to_anthropic_specs(tools)
    messages: list[dict[str, Any]] = [{"role": "user", "content": task}]
    res = AgentResult(turns=0, input_tokens=0, output_tokens=0, stop="max_turns")

    for _ in range(cfg.max_turns):
        res.turns += 1
        r = llm.complete(system, messages, specs)
        res.input_tokens += r.input_tokens
        res.output_tokens += r.output_tokens
        messages.append({"role": "assistant", "content": r.content})

        tool_uses = [b for b in r.content if b.get("type") == "tool_use"]
        if not tool_uses:
            res.stop = "done"
            break

        results = []
        for tu in tool_uses:
            tool = by_name.get(tu["name"])
            output = tool.run(tu.get("input", {})) if tool else f"ERROR: unknown tool {tu['name']}"
            results.append(
                {"type": "tool_result", "tool_use_id": tu["id"], "content": output}
            )
        messages.append({"role": "user", "content": results})

    res.transcript = messages
    return res
