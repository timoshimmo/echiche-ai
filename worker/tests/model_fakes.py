"""Test doubles for the model layer: a scripted ModelClient and the shared fixtures."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from echiche_worker.llm import OPENAI_PRICES, ModelCallError, ModelReply, ModelRequest, TokenUsage
from echiche_worker.model_provider import ModelReasoningProvider, ModelSettings
from echiche_worker.prompts import PromptRegistry

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
USAGE = TokenUsage(input_tokens=1200, cached_input_tokens=200, output_tokens=600, reasoning_tokens=100)


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.valid.json").read_text())


VALID: dict[str, str] = {
    "decision_frame_v1": json.dumps(fixture("decision-frame.v1")),
    "critique_v1": json.dumps(fixture("critique.v1")),
    "decision_brief_v1": json.dumps(fixture("decision-brief.v1")),
}

Step = ModelReply | ModelCallError | str | Callable[[ModelRequest], ModelReply]


def reply(text: str, status: str = "completed", usage: TokenUsage = USAGE) -> ModelReply:
    return ModelReply(status=status, text=text, usage=usage, model="gpt-6.1-sol-2026-09-01", latency_ms=42)


class FakeModelClient:
    """Answers each request with the next scripted step for its schema, else a valid fixture."""

    provider = "openai"

    def __init__(self, model: str = "gpt-6.1-sol", script: dict[str, list[Step]] | None = None) -> None:
        self.model = model
        self.script = {k: list(v) for k, v in (script or {}).items()}
        self.requests: list[ModelRequest] = []

    def generate(self, request: ModelRequest) -> ModelReply:
        self.requests.append(request)
        queue = self.script.get(request.schema_name)
        step: Step = queue.pop(0) if queue else VALID[request.schema_name]
        if isinstance(step, ModelCallError):
            raise step
        if isinstance(step, str):
            return reply(step)
        if isinstance(step, ModelReply):
            return step
        return step(request)


def model_provider(
    client: FakeModelClient | None = None, residency: str = "global", max_output_tokens: int = 4000
) -> ModelReasoningProvider:
    return ModelReasoningProvider(
        client or FakeModelClient(),
        PromptRegistry.load(),
        OPENAI_PRICES,
        ModelSettings(residency=residency, max_output_tokens=max_output_tokens),
    )
