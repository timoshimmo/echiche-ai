import json
import time
from decimal import Decimal
from pathlib import Path
from threading import Event

import pytest
from pydantic import ValidationError

from echiche_worker import contracts
from echiche_worker.compose import MissingStageError, compose_result
from echiche_worker.contracts import STAGES, ReasoningScaffoldResultV1, Stage, StageOutput, StageOutputV1
from echiche_worker.executor import budget_exceeded
from echiche_worker.provider import (
    DeterministicProvider,
    ProviderError,
    ProviderTimeoutError,
    StageContext,
    TransientProviderError,
    call_with_timeout,
)
from echiche_worker.retry import RetryPolicy, run_with_retries
from echiche_worker.store import Budget, ClaimedRun, Usage

CONTRACTS_DIR = Path(__file__).resolve().parents[2] / "contracts"


def all_outputs(prompt: str = "Should we enter market X next year?") -> dict[Stage, StageOutput]:
    provider = DeterministicProvider()
    outputs: dict[Stage, StageOutput] = {}
    for stage in STAGES:
        ctx = StageContext(run_id="r", prompt=prompt, previous=dict(outputs), timeout_seconds=5)
        outputs[stage] = provider.run_stage(stage, ctx).output
    return outputs


# --- contracts ---------------------------------------------------------------------


def test_committed_schemas_are_current() -> None:
    assert contracts.main(["--check", "--dir", str(CONTRACTS_DIR)]) == 0


def test_shared_fixtures_match_the_contract() -> None:
    valid = json.loads((CONTRACTS_DIR / "fixtures" / "reasoning-scaffold.v1.valid.json").read_text())
    ReasoningScaffoldResultV1.model_validate(valid)
    for invalid in json.loads((CONTRACTS_DIR / "fixtures" / "reasoning-scaffold.v1.invalid.json").read_text()):
        with pytest.raises(ValidationError):
            ReasoningScaffoldResultV1.model_validate(invalid)


def test_contracts_reject_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        StageOutputV1.model_validate({"stage": "planning", "title": "t", "content": "c", "extra": 1})


# --- provider, compose -------------------------------------------------------------


def test_deterministic_provider_covers_every_stage_and_discloses_no_research() -> None:
    outputs = all_outputs()
    assert list(outputs) == list(STAGES)
    assert outputs["researching"].limitations
    assert "Should we enter market X" in outputs["planning"].content


def test_compose_result_is_valid_and_carries_limitations() -> None:
    result = compose_result("  Should   we enter market X?  ", all_outputs())
    assert [s.stage for s in result.stages] == ["frame", "challenge", "synthesize"]
    assert "Should we enter market X?" in result.summary
    assert "No research provider is configured" in result.caveat
    ReasoningScaffoldResultV1.model_validate(result.model_dump())


def test_compose_result_requires_checkpoints() -> None:
    outputs = all_outputs()
    del outputs["critiquing"]
    with pytest.raises(MissingStageError):
        compose_result("question text here", outputs)


def test_compose_bounds_long_prompts() -> None:
    assert len(compose_result("a" * 2000, all_outputs()).summary) < 500


# --- timeouts and retries ----------------------------------------------------------


def test_call_with_timeout_raises_transient_timeout() -> None:
    with pytest.raises(ProviderTimeoutError):
        call_with_timeout(lambda: time.sleep(0.5), 0.05)
    assert call_with_timeout(lambda: 42, 1) == 42


def test_retries_transient_errors_then_succeeds() -> None:
    calls = {"n": 0}

    def flaky() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise TransientProviderError("blip")
        return "ok"

    policy = RetryPolicy(max_tries=3, base_seconds=0.001, cap_seconds=0.002)
    assert run_with_retries(flaky, policy, Event()) == "ok"
    assert calls["n"] == 3


def test_retries_are_bounded() -> None:
    calls = {"n": 0}

    def always() -> None:
        calls["n"] += 1
        raise TransientProviderError("down")

    with pytest.raises(TransientProviderError):
        run_with_retries(always, RetryPolicy(max_tries=3, base_seconds=0.001), Event())
    assert calls["n"] == 3


def test_permanent_errors_are_not_retried() -> None:
    calls = {"n": 0}

    def broken() -> None:
        calls["n"] += 1
        raise ProviderError("bad request")

    with pytest.raises(ProviderError):
        run_with_retries(broken, RetryPolicy(max_tries=5, base_seconds=0.001), Event())
    assert calls["n"] == 1


def test_shutdown_interrupts_backoff() -> None:
    shutdown = Event()
    shutdown.set()
    with pytest.raises(TransientProviderError):
        run_with_retries(
            lambda: (_ for _ in ()).throw(TransientProviderError("x")), RetryPolicy(base_seconds=60), shutdown
        )


def test_backoff_is_capped_with_jitter() -> None:
    policy = RetryPolicy(base_seconds=0.5, cap_seconds=8)
    assert policy.delay(1, rand=lambda: 1.0) == 0.5
    assert policy.delay(10, rand=lambda: 1.0) == 8
    assert policy.delay(3, rand=lambda: 0.0) == 0


# --- budgets -----------------------------------------------------------------------


def run_with(budget: Budget, usage: Usage) -> ClaimedRun:
    return ClaimedRun(
        id="r", owner_user_id="o", prompt="p", status="queued", attempt=1, max_attempts=3, budget=budget, usage=usage
    )


BUDGET = Budget(max_steps=5, max_active_seconds=10, max_research_calls=2, max_cost_usd=Decimal("0.10"))
ZERO = Usage(steps=0, active_seconds=Decimal(0), research_calls=0, cost_usd=Decimal(0))


@pytest.mark.parametrize(
    ("usage", "code"),
    [
        (ZERO, None),
        (Usage(steps=5, active_seconds=Decimal(0), research_calls=0, cost_usd=Decimal(0)), "BUDGET_STEPS"),
        (Usage(steps=1, active_seconds=Decimal(10), research_calls=0, cost_usd=Decimal(0)), "BUDGET_TIME"),
        (Usage(steps=1, active_seconds=Decimal(1), research_calls=2, cost_usd=Decimal(0)), "BUDGET_RESEARCH"),
        (Usage(steps=1, active_seconds=Decimal(1), research_calls=0, cost_usd=Decimal("0.10")), "BUDGET_COST"),
    ],
)
def test_budget_exceeded(usage: Usage, code: str | None) -> None:
    assert budget_exceeded(run_with(BUDGET, usage), usage) == code


def test_research_cap_only_blocks_the_research_stage() -> None:
    used = Usage(steps=1, active_seconds=Decimal(1), research_calls=2, cost_usd=Decimal(0))
    run = run_with(BUDGET, used)
    assert budget_exceeded(run, used, "researching") == "BUDGET_RESEARCH"
    assert budget_exceeded(run, used, "critiquing") is None
