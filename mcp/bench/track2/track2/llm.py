"""LLM abstraction. The loop talks only to the LLM protocol so it can be driven
by a deterministic MockLLM in tests (no network) or the real Anthropic API."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class LLMResponse:
    stop_reason: str  # "tool_use" | "end_turn" | ...
    content: list[dict[str, Any]]  # raw Anthropic content blocks (text / tool_use)
    input_tokens: int = 0
    output_tokens: int = 0


class LLM(Protocol):
    def complete(
        self, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> LLMResponse: ...


@dataclass
class MockLLM:
    """Replays a fixed script of responses for deterministic loop tests.
    Each script entry is a list of content blocks (text and/or tool_use)."""
    script: list[list[dict[str, Any]]]
    calls: list[dict[str, Any]] = field(default_factory=list)
    _i: int = 0

    def complete(self, system, messages, tools) -> LLMResponse:
        self.calls.append({"system": system, "messages": list(messages), "tools": tools})
        blocks = self.script[self._i]
        self._i += 1
        stop = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
        return LLMResponse(stop_reason=stop, content=blocks, input_tokens=10, output_tokens=5)


class AnthropicLLM:
    def __init__(self, model: str, max_tokens: int, temperature: float):
        from anthropic import Anthropic  # imported lazily so tests don't need the key
        self._client = Anthropic()
        self._model, self._max_tokens, self._temp = model, max_tokens, temperature

    def complete(self, system, messages, tools) -> LLMResponse:
        resp = self._client.messages.create(
            model=self._model,
            max_tokens=self._max_tokens,
            temperature=self._temp,
            system=system,
            tools=tools,
            messages=messages,
        )
        content = [b.model_dump() for b in resp.content]
        return LLMResponse(
            stop_reason=resp.stop_reason,
            content=content,
            input_tokens=resp.usage.input_tokens,
            output_tokens=resp.usage.output_tokens,
        )
