"""Reasoning provider port and the deterministic (non-LLM) implementation.

M4 adds a real model-backed provider behind the same protocol. Error classes carry
the stable codes stored in thought_runs.error_code.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Protocol

from echiche_worker.contracts import Stage, StageOutputV1


class ProviderError(Exception):
    """Permanent provider failure: retrying will not help."""

    code = "PROVIDER_ERROR"


class TransientProviderError(ProviderError):
    """Temporary failure (timeout, 5xx, rate limit): safe to retry with backoff."""

    code = "PROVIDER_UNAVAILABLE"


class ProviderTimeoutError(TransientProviderError):
    code = "PROVIDER_TIMEOUT"


class InvalidProviderOutputError(ProviderError):
    """Output failed its schema. M4 adds one bounded repair attempt before this is final."""

    code = "INVALID_PROVIDER_OUTPUT"


@dataclass(frozen=True, slots=True)
class StageContext:
    run_id: str
    prompt: str
    previous: Mapping[Stage, StageOutputV1]
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class StageResult:
    output: StageOutputV1
    research_calls: int = 0
    cost_usd: Decimal = field(default_factory=lambda: Decimal("0"))


class ReasoningProvider(Protocol):
    def run_stage(self, stage: Stage, ctx: StageContext) -> StageResult: ...


def call_with_timeout[T](fn: Callable[[], T], seconds: float) -> T:
    """Runs fn with a deadline. On timeout raises ProviderTimeoutError.

    Python cannot kill a thread, so a timed-out call keeps running in the background
    and its result is discarded. Real providers must also set their own I/O timeouts.
    """
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stage")
    future = pool.submit(fn)
    try:
        return future.result(timeout=seconds)
    except FutureTimeout as exc:
        raise ProviderTimeoutError(f"stage exceeded {seconds:g}s") from exc
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _clean(prompt: str) -> str:
    text = " ".join(prompt.split())
    return text if len(text) <= 360 else f"{text[:357]}..."


NO_RESEARCH = "No research provider is configured: no external evidence was gathered or verified."


class DeterministicProvider:
    """The M1/M2 scaffold, split into blueprint stages. Not an LLM; no research."""

    def run_stage(self, stage: Stage, ctx: StageContext) -> StageResult:
        question = _clean(ctx.prompt)
        texts: dict[Stage, tuple[str, str, list[str]]] = {
            "planning": (
                "Frame the decision",
                f"Decision/question: {question}\n\nDefine the desired outcome, deadline, affected people, "
                "constraints, and what a good decision would look like. Separate known facts from assumptions "
                "before choosing a path.",
                [],
            ),
            "researching": ("Research skipped", NO_RESEARCH, [NO_RESEARCH]),
            "critiquing": (
                "Challenge assumptions",
                "Test the most important assumptions behind this question. What evidence would change your mind? "
                "Consider at least one alternative explanation, the cost of being wrong, reversibility, and the "
                "strongest argument against your preferred option.",
                [],
            ),
            "verifying": (
                "Check structure",
                "Verified that framing, critique and synthesis inputs are present and well-formed. "
                "No factual claims were verified because no research was performed.",
                ["Structural check only; no claims or citations to verify."],
            ),
            "synthesizing": (
                "Synthesize a next step",
                "Do not treat missing information as fact. List the 1–3 uncertainties that most affect the "  # noqa: RUF001 - user-facing en dash
                "decision, gather the cheapest reliable evidence for them, then choose a small reversible next "
                "step with an owner, a deadline, and a measurable success signal.",
                [],
            ),
        }
        title, content, limitations = texts[stage]
        return StageResult(output=StageOutputV1(stage=stage, title=title, content=content, limitations=limitations))
