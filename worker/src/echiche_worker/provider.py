"""Reasoning provider port, error taxonomy, and the deterministic (non-LLM) provider.

The model-backed provider (M4) lives in `model_provider.py` behind the same protocol.
Error classes carry the stable codes stored in thought_runs.error_code.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal, Protocol

from echiche_worker.contracts import Stage, StageOutput, StageOutputV2
from echiche_worker.memory import ContextItem, DecisionItem, MemoryItem


class ProviderError(Exception):
    """Permanent provider failure: retrying will not help."""

    code = "PROVIDER_ERROR"


class TransientProviderError(ProviderError):
    """Temporary failure (timeout, 5xx, connection): safe to retry with backoff."""

    code = "PROVIDER_UNAVAILABLE"

    def __init__(self, message: str = "", retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ProviderRateLimitedError(TransientProviderError):
    code = "PROVIDER_RATE_LIMITED"


class ProviderTimeoutError(TransientProviderError):
    code = "PROVIDER_TIMEOUT"


class InvalidProviderOutputError(ProviderError):
    """Output failed its contract (after the one bounded repair attempt)."""

    code = "INVALID_PROVIDER_OUTPUT"


class ProviderRefusedError(ProviderError):
    code = "PROVIDER_REFUSED"


class ProviderOutputTruncatedError(ProviderError):
    code = "PROVIDER_OUTPUT_TRUNCATED"


class ProviderAuthError(ProviderError):
    """Bad or unauthorised API key: an operator problem, never retried."""

    code = "PROVIDER_AUTH"


class ProviderRequestError(ProviderError):
    """The provider rejected the request itself (e.g. unsupported parameter)."""

    code = "PROVIDER_REQUEST_INVALID"


class BudgetPreflightError(ProviderError):
    """The worst-case cost of the next call would exceed the run's remaining spend cap.
    The executor pauses the run for budget instead of failing it."""

    code = "BUDGET_COST"


CallOutcome = Literal["ok", "invalid_output", "refused", "truncated", "error"]


@dataclass(frozen=True, slots=True)
class ModelCallRecord:
    """Telemetry for one provider call (echiche.model_calls). Never contains content."""

    stage: Stage
    provider: str
    model: str
    prompt_id: str
    prompt_version: str
    prompt_sha256: str
    output_schema: str
    repair: bool
    outcome: CallOutcome
    error_code: str | None
    input_tokens: int
    cached_input_tokens: int
    output_tokens: int
    reasoning_tokens: int
    cost_usd: Decimal
    latency_ms: int


ResearchKind = Literal["search", "fetch", "robots"]


@dataclass(frozen=True, slots=True)
class ResearchCallRecord:
    """Telemetry for one search or fetch (echiche.research_calls). No query text, no content."""

    kind: ResearchKind
    provider: str
    outcome: str
    http_status: int | None
    domain: str | None
    result_count: int
    bytes: int
    cost_usd: Decimal
    latency_ms: int


@dataclass(frozen=True, slots=True)
class StageContext:
    run_id: str
    prompt: str
    previous: Mapping[Stage, StageOutput]
    timeout_seconds: float
    project_context: str = ""
    remaining_cost_usd: Decimal = field(default_factory=lambda: Decimal("0"))
    # Providers append one record per model call, including failed ones, so the
    # executor can persist telemetry and count spend whatever the outcome.
    calls: list[ModelCallRecord] = field(default_factory=list[ModelCallRecord])
    research_calls: list[ResearchCallRecord] = field(default_factory=list[ResearchCallRecord])
    # Research limits for this stage: searches still allowed by the run's budget, and whether
    # this is the last attempt (then a failing search provider degrades to "no evidence",
    # with an explicit limitation, instead of failing the run).
    remaining_research_calls: int = 0
    final_attempt: bool = False
    # Project memory (M6): active memories and the active decision, already filtered to this
    # owner and project; and what an earlier attempt of this run already selected.
    project_memories: list[MemoryItem] = field(default_factory=list[MemoryItem])
    project_decision: DecisionItem | None = None
    run_memory: list[ContextItem] = field(default_factory=list[ContextItem])

    def spent_usd(self) -> Decimal:
        return sum((c.cost_usd for c in self.calls), Decimal("0")) + sum(
            (c.cost_usd for c in self.research_calls), Decimal("0")
        )


@dataclass(frozen=True, slots=True)
class StageResult:
    output: StageOutput
    research_calls: int = 0
    cost_usd: Decimal = field(default_factory=lambda: Decimal("0"))
    memory_context: list[ContextItem] = field(default_factory=list[ContextItem])  # set by planning only


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
    """The M1/M2 scaffold, split into blueprint stages. Not an LLM; no research ("demo mode")."""

    name = "deterministic"

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
        return StageResult(output=StageOutputV2(stage=stage, title=title, content=content, limitations=limitations))
