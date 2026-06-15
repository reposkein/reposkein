"""Tool protocol shared by all arms. A Tool exposes an Anthropic tool spec
(name/description/input_schema) and a run() that takes the model's input dict
and returns a string the loop feeds back as a tool_result."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Protocol


class Tool(Protocol):
    name: str
    description: str
    input_schema: dict[str, Any]  # JSON Schema for Anthropic tool-use

    def run(self, args: dict[str, Any]) -> str: ...


@dataclass
class FuncTool:
    """Concrete Tool backed by a plain callable."""
    name: str
    description: str
    input_schema: dict[str, Any]
    fn: Callable[[dict[str, Any]], str]

    def run(self, args: dict[str, Any]) -> str:
        try:
            return self.fn(args)
        except Exception as e:  # tool errors are surfaced to the model, not fatal
            return f"ERROR: {type(e).__name__}: {e}"


def to_anthropic_specs(tools: list[Tool]) -> list[dict[str, Any]]:
    return [
        {"name": t.name, "description": t.description, "input_schema": t.input_schema}
        for t in tools
    ]
