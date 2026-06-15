from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class AgentConfig:
    model: str = "claude-sonnet-4-6"
    max_turns: int = 40
    max_tokens: int = 8192
    temperature: float = 0.0
