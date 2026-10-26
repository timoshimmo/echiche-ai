"""Opt-in live smoke test: ONE real, billed OpenAI call through the full planning stage.

Never runs in CI or by default. To run it with your own key (cost: well under $0.05
at the verified gpt-6.1-sol price; the preflight cap below enforces it):

    ECHICHE_LIVE_OPENAI=1 OPENAI_API_KEY=... uv run pytest -m live -s
"""

from __future__ import annotations

import os
from decimal import Decimal

import pytest

from echiche_worker.contracts import DecisionFrameV1
from echiche_worker.llm import OPENAI_PRICES
from echiche_worker.model_provider import ModelReasoningProvider, ModelSettings
from echiche_worker.prompts import PromptRegistry
from echiche_worker.provider import StageContext

pytestmark = pytest.mark.live


@pytest.mark.skipif(os.environ.get("ECHICHE_LIVE_OPENAI") != "1", reason="set ECHICHE_LIVE_OPENAI=1 to opt in")
def test_live_framing_call_returns_a_valid_decision_frame() -> None:
    from echiche_worker.openai_adapter import OpenAIModelClient

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    assert key, "OPENAI_API_KEY is required for the live test"
    model = os.environ.get("OPENAI_MODEL", "gpt-6.1-sol")
    residency = os.environ.get("OPENAI_DATA_RESIDENCY", "global")
    client = OpenAIModelClient(api_key=key, model=model, data_residency=residency)
    provider = ModelReasoningProvider(
        client, PromptRegistry.load(), OPENAI_PRICES, ModelSettings(residency=residency, max_output_tokens=2000)
    )
    ctx = StageContext(
        run_id="live-smoke",
        prompt="Should a two-person studio take a large fixed-price contract that would pause its own product?",
        previous={},
        timeout_seconds=90,
        project_context="Project title: Studio planning\n\nProblem statement:\nSynthetic test decision; no real data.",
        remaining_cost_usd=Decimal("0.05"),
    )
    output = provider.run_stage("planning", ctx).output
    assert getattr(output, "data_schema", None) == "decision-frame.v1"
    DecisionFrameV1.model_validate(getattr(output, "data", None))
    call = ctx.calls[-1]
    assert call.outcome == "ok" and call.input_tokens > 0 and call.output_tokens > 0
    print(f"\nlive call ok: model={call.model} in={call.input_tokens} out={call.output_tokens} cost=${call.cost_usd}")
