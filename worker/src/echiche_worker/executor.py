"""Executes one claimed run: resume from checkpoints, enforce cancellation and budgets,
call the provider per stage with timeouts and bounded retries, and record outcomes.

Failure policy (stable codes in thought_runs.error_code):
  transient provider error, retries exhausted in this claim -> back to queue with backoff,
      or failed with that code once max_attempts is used up
  invalid provider output / permanent provider error        -> failed (code from the error)
  worst-case model cost above the remaining spend cap        -> paused_for_budget BUDGET_COST
  composed result breaks its contract                       -> failed RESULT_INVALID
  corrupt checkpoint                                         -> failed CHECKPOINT_INVALID
  claim count above max_attempts                             -> failed RUN_RETRIES_EXHAUSTED
  unexpected exception                                       -> failed INTERNAL_ERROR
  lease lost                                                 -> stop, write nothing
  graceful shutdown                                          -> back to queue, attempt not consumed

Model-call telemetry and spend are persisted on every path that follows a call (commit,
failure, requeue, pause), so failed and retried calls still count against the budget.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from threading import Event

from pydantic import ValidationError

from echiche_worker.compose import MissingStageError, compose_final
from echiche_worker.contracts import STAGES, Stage, StageOutputV2
from echiche_worker.log import log
from echiche_worker.provider import (
    BudgetPreflightError,
    ProviderError,
    ReasoningProvider,
    StageContext,
    StageResult,
    TransientProviderError,
    call_with_timeout,
)
from echiche_worker.retry import RetryPolicy, run_with_retries
from echiche_worker.routing import QUICK_ROUTE_LIMITATION, SKIPPED_STAGE_TEXT, RouteSettings, RoutingPolicy, route_for
from echiche_worker.store import ClaimedRun, CorruptCheckpointError, LeaseLostError, RunStore, Usage, to_v2

STAGE_TITLES: dict[Stage, str] = {
    "planning": "Planning",
    "researching": "Research",
    "critiquing": "Critique",
    "verifying": "Verification",
    "synthesizing": "Synthesis",
}


class Outcome(Enum):
    AWAITING_REVIEW = "awaiting_user_review"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PAUSED = "paused_for_budget"
    REQUEUED = "queued"
    LEASE_LOST = "lease_lost"


@dataclass(frozen=True, slots=True)
class ExecutorSettings:
    stage_timeout_seconds: float
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    requeue_base_seconds: float = 5.0
    routing: RoutingPolicy | None = None  # M7; None = every run gets the full pipeline


def budget_exceeded(run: ClaimedRun, usage: Usage, stage: Stage | None = None) -> str | None:
    """Checked before each stage. Caps are never raised here; only the user can (resume).

    The research cap is checked only before the researching stage (the only stage that
    searches): a run that used its last search can still finish critique and synthesis.
    """
    budget = run.budget
    if usage.steps >= budget.max_steps:
        return "BUDGET_STEPS"
    if usage.active_seconds >= budget.max_active_seconds:
        return "BUDGET_TIME"
    if (
        stage in (None, "researching")
        and budget.max_research_calls > 0
        and usage.research_calls >= budget.max_research_calls
    ):
        return "BUDGET_RESEARCH"
    if budget.max_cost_usd > 0 and usage.cost_usd >= budget.max_cost_usd:
        return "BUDGET_COST"
    return None


class LeaseKeeper:
    """Renews the lease on a separate connection while a stage runs, so a long provider
    call doesn't let the lease expire. Stops renewing as soon as a renewal fails."""

    def __init__(self, renew: Callable[[], bool], interval_seconds: float) -> None:
        self._renew = renew
        self._interval = interval_seconds
        self._stop = Event()
        self.lost = Event()
        self._thread = threading.Thread(target=self._loop, name="lease-keeper", daemon=True)

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                if not self._renew():
                    self.lost.set()
                    return
            except Exception:  # noqa: BLE001 - connection trouble: the guarded writes will notice
                self.lost.set()
                return

    def __enter__(self) -> LeaseKeeper:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=5)


def execute(
    run: ClaimedRun,
    store: RunStore,
    provider: ReasoningProvider,
    settings: ExecutorSettings,
    shutdown: Event,
    renew_lease: Callable[[], bool] | None = None,
) -> Outcome:
    fields = {"run_id": run.id, "attempt": run.attempt}
    try:
        return _execute(run, store, provider, settings, shutdown, renew_lease)
    except LeaseLostError:
        log("warn", "lease_lost", **fields)
        return Outcome.LEASE_LOST
    except Exception as error:  # noqa: BLE001 - last line of defence: never leave a run active
        log(
            "error",
            "run_internal_error",
            error_code="INTERNAL_ERROR",
            error_name=type(error).__name__,
            **fields,
        )
        try:
            store.fail(run, "INTERNAL_ERROR")
        except LeaseLostError:
            return Outcome.LEASE_LOST
        return Outcome.FAILED


def _execute(
    run: ClaimedRun,
    store: RunStore,
    provider: ReasoningProvider,
    settings: ExecutorSettings,
    shutdown: Event,
    renew_lease: Callable[[], bool] | None,
) -> Outcome:
    fields = {"run_id": run.id, "attempt": run.attempt}
    if run.attempt > run.max_attempts:
        store.fail(run, "RUN_RETRIES_EXHAUSTED")
        log("error", "run_failed", error_code="RUN_RETRIES_EXHAUSTED", **fields)
        return Outcome.FAILED

    try:
        outputs = store.load_checkpoints(run.id)
    except CorruptCheckpointError:
        store.fail(run, CorruptCheckpointError.code)
        log("error", "run_failed", error_code=CorruptCheckpointError.code, **fields)
        return Outcome.FAILED
    if outputs:
        log("info", "run_resumed", completed_stages=list(outputs), **fields)

    usage = run.usage
    route = route_for(settings.routing, run.route_tier)
    load = "planning" not in outputs and route.memory
    memories, decision = store.load_project_memory(run) if load else ([], None)
    run_memory = store.load_run_memory(run.id)
    for stage in STAGES:
        if stage in outputs:
            continue
        if shutdown.is_set():
            store.release_for_retry(run, 0, "WORKER_SHUTDOWN", consume_attempt=False)
            log("info", "run_released_on_shutdown", stage=stage, **fields)
            return Outcome.REQUEUED
        if store.cancel_requested(run.id):
            store.cancel(run)
            log("info", "run_cancelled", stage=stage, **fields)
            return Outcome.CANCELLED
        skip = _skipped_output(route, stage, outputs)
        if skip is not None:
            # The tier leaves this stage out: checkpoint it as skipped (no provider call, no cost),
            # so resume, composition and the run timeline all see an explicit record of it.
            usage = store.commit_stage(run, skip, 0, 0, Decimal(0))
            outputs[stage] = skip
            log("info", "stage_skipped_by_route", stage=stage, tier=route.label, **fields)
            continue
        exceeded = budget_exceeded(run, usage, stage)
        if exceeded:
            store.pause_for_budget(run, exceeded)
            log("info", "run_paused_for_budget", stage=stage, error_code=exceeded, **fields)
            return Outcome.PAUSED

        store.begin_stage(run, stage, STAGE_TITLES[stage])
        remaining = float(run.budget.max_active_seconds - usage.active_seconds)
        timeout = max(0.001, min(settings.stage_timeout_seconds, remaining))
        ctx = StageContext(
            run_id=run.id,
            prompt=run.prompt,
            previous=dict(outputs),
            timeout_seconds=timeout,
            project_context=run.project_context,
            remaining_cost_usd=run.budget.max_cost_usd - usage.cost_usd,
            remaining_research_calls=max(0, run.budget.max_research_calls - usage.research_calls),
            final_attempt=run.attempt >= run.max_attempts,
            project_memories=memories,
            project_decision=decision,
            run_memory=list(run_memory),
            route=route,
        )
        started = time.monotonic()
        try:
            keeper_interval = max(1.0, store.lease_seconds / 3)
            if renew_lease is not None:
                with LeaseKeeper(renew_lease, keeper_interval) as keeper:
                    result = _call(provider, stage, ctx, settings, shutdown, fields)
                if keeper.lost.is_set():
                    raise LeaseLostError(run.id)
            else:
                result = _call(provider, stage, ctx, settings, shutdown, fields)
        except BudgetPreflightError as error:
            store.record_calls(run, ctx.calls, ctx.research_calls)
            store.pause_for_budget(run, error.code)
            log("info", "run_paused_for_budget", stage=stage, error_code=error.code, **fields)
            return Outcome.PAUSED
        except TransientProviderError as error:
            store.record_calls(run, ctx.calls, ctx.research_calls)
            if shutdown.is_set():
                store.release_for_retry(run, 0, "WORKER_SHUTDOWN", consume_attempt=False)
                return Outcome.REQUEUED
            if run.attempt >= run.max_attempts:
                store.fail(run, error.code)
                log("error", "run_failed", stage=stage, error_code=error.code, **fields)
                return Outcome.FAILED
            delay = max(settings.requeue_base_seconds * (2 ** (run.attempt - 1)), error.retry_after or 0)
            store.release_for_retry(run, delay, error.code)
            log("warn", "run_requeued", stage=stage, error_code=error.code, **fields)
            return Outcome.REQUEUED
        except ProviderError as error:
            store.record_calls(run, ctx.calls, ctx.research_calls)
            store.fail(run, error.code)
            log("error", "run_failed", stage=stage, error_code=error.code, **fields)
            return Outcome.FAILED

        if result.output.stage != stage:
            store.record_calls(run, ctx.calls, ctx.research_calls)
            store.fail(run, "INVALID_PROVIDER_OUTPUT")
            log("error", "run_failed", stage=stage, error_code="INVALID_PROVIDER_OUTPUT", **fields)
            return Outcome.FAILED
        duration_ms = int((time.monotonic() - started) * 1000)
        cost = Decimal(result.cost_usd) + ctx.spent_usd()
        usage = store.commit_stage(
            run,
            result.output,
            duration_ms,
            result.research_calls,
            cost,
            ctx.calls,
            ctx.research_calls,
            result.memory_context,
            result.escalation,
        )
        outputs[stage] = to_v2(result.output)
        if result.memory_context:
            run_memory = list(result.memory_context)
        log("info", "stage_completed", stage=stage, duration_ms=duration_ms, **fields)

    try:
        schema_version, final = compose_final(run.prompt, outputs)
    except (MissingStageError, ValidationError):
        store.fail(run, "RESULT_INVALID")
        log("error", "run_failed", error_code="RESULT_INVALID", **fields)
        return Outcome.FAILED
    store.finish(run, schema_version, final)
    log("info", "run_awaiting_review", **fields)
    return Outcome.AWAITING_REVIEW


_ROUTED: dict[Stage, str] = {"researching": "research", "critiquing": "critique", "verifying": "verify"}


def _skipped_output(route: RouteSettings, stage: Stage, outputs: dict[Stage, StageOutputV2]) -> StageOutputV2 | None:
    flag = _ROUTED.get(stage)
    if flag is None or getattr(route, flag):
        return None
    first = not any(s in outputs and outputs[s].title.startswith("Skipped") for s in _ROUTED)
    return StageOutputV2(
        stage=stage,
        title=f"Skipped ({route.label} route)",
        content=SKIPPED_STAGE_TEXT[stage],
        limitations=[QUICK_ROUTE_LIMITATION] if first else [],
    )


def _call(
    provider: ReasoningProvider,
    stage: Stage,
    ctx: StageContext,
    settings: ExecutorSettings,
    shutdown: Event,
    fields: dict[str, str | int],
) -> StageResult:
    def attempt() -> StageResult:
        return call_with_timeout(lambda: provider.run_stage(stage, ctx), ctx.timeout_seconds)

    def on_retry(n: int, error: TransientProviderError) -> None:
        log("warn", "stage_retry", stage=stage, retry=n, error_code=error.code, **fields)

    return run_with_retries(attempt, settings.retry, shutdown, on_retry)
