"""Durability, failure and state-machine tests against real Postgres as echiche_worker."""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from decimal import Decimal
from threading import Event
from typing import Any, LiteralString

import psycopg
import pytest
from psycopg.rows import DictRow

from echiche_worker.contracts import STAGES, ReasoningScaffoldResultV1, Stage, StageOutputV1
from echiche_worker.executor import ExecutorSettings, Outcome, execute
from echiche_worker.provider import (
    DeterministicProvider,
    InvalidProviderOutputError,
    StageContext,
    StageResult,
    TransientProviderError,
)
from echiche_worker.retry import RetryPolicy
from echiche_worker.store import LeaseLostError, RunStore

from .conftest import as_end_user, checkpoints, create_run, events, run_row

pytestmark = [pytest.mark.integration, pytest.mark.usefixtures("clean")]

FAST = ExecutorSettings(stage_timeout_seconds=2, retry=RetryPolicy(max_tries=3, base_seconds=0.001, cap_seconds=0.002))
Admin = psycopg.Connection[DictRow]


class SimulatedCrash(BaseException):
    """Escapes the executor's exception handling, like the process being killed."""


class Scripted(DeterministicProvider):
    """Deterministic provider with injectable behaviour per stage."""

    def __init__(self, **behaviour: Any) -> None:
        self.behaviour = behaviour
        self.calls: list[Stage] = []

    def run_stage(self, stage: Stage, ctx: StageContext) -> StageResult:
        self.calls.append(stage)
        action = self.behaviour.get(stage)
        if callable(action):
            action()
        return super().run_stage(stage, ctx)


def expire_lease(admin: Admin, run_id: str) -> None:
    admin.execute(
        "update echiche.thought_runs set lease_expires_at = now() - interval '1 second' where id = %s", (run_id,)
    )


# --- happy path ----------------------------------------------------------------------


def test_runs_all_stages_and_awaits_review(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None and run.id == run_id and run.attempt == 1

    assert execute(run, store, DeterministicProvider(), FAST, Event()) is Outcome.AWAITING_REVIEW

    row = run_row(admin, run_id)
    assert row["status"] == "awaiting_user_review"
    assert row["claimed_by"] is None and row["lease_expires_at"] is None
    assert row["steps_used"] == 5 and row["result_schema_version"] == "reasoning-scaffold.v1"
    ReasoningScaffoldResultV1.model_validate(row["result"])
    assert checkpoints(admin, run_id) == list(STAGES)
    seq = events(admin, run_id)
    assert [s for s, _, _ in seq] == list(range(1, 12))  # 5 x (started, completed) + result
    assert seq[-1][1:] == ("result", "complete")


# --- crash recovery & duplicate delivery ---------------------------------------------


def test_crash_mid_run_resumes_from_checkpoint_without_duplicates(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    first: RunStore = store_factory("worker-a")
    run = first.claim()
    assert run is not None

    def crash() -> None:
        raise SimulatedCrash

    with pytest.raises(SimulatedCrash):
        execute(run, first, Scripted(critiquing=crash), FAST, Event())
    assert checkpoints(admin, run_id) == ["planning", "researching"]  # critiquing never committed
    assert run_row(admin, run_id)["status"] == "critiquing"

    # Nobody can take over while the lease is valid...
    second: RunStore = store_factory("worker-b")
    assert second.claim() is None
    # ...but once it expires, another worker resumes exactly where the first stopped.
    expire_lease(admin, run_id)
    resumed = second.claim()
    assert resumed is not None and resumed.attempt == 2
    provider = Scripted()
    assert execute(resumed, second, provider, FAST, Event()) is Outcome.AWAITING_REVIEW
    assert provider.calls == ["critiquing", "verifying", "synthesizing"]

    row = run_row(admin, run_id)
    assert row["steps_used"] == 5
    assert checkpoints(admin, run_id) == list(STAGES)
    completed = [stage for _, kind, stage in events(admin, run_id) if kind == "stage"]
    assert completed.count("planning") == 2  # started + completed, once each
    assert len({s for s, _, _ in events(admin, run_id)}) == len(events(admin, run_id))


def test_concurrent_workers_never_claim_the_same_run(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    stores = [store_factory(f"worker-{i}") for i in range(6)]
    claimed: list[str] = []
    barrier = threading.Barrier(len(stores))

    def claim(store: RunStore) -> None:
        barrier.wait()
        run = store.claim()
        if run:
            claimed.append(run.id)

    threads = [threading.Thread(target=claim, args=(s,)) for s in stores]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert claimed == [run_id]


def test_a_worker_that_lost_its_lease_cannot_write(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    slow: RunStore = store_factory("worker-slow")
    run = slow.claim()
    assert run is not None
    slow.begin_stage(run, "planning", "Planning")
    expire_lease(admin, run_id)
    fast: RunStore = store_factory("worker-fast")
    assert fast.claim() is not None

    output = StageOutputV1(stage="planning", title="t", content="c")
    with pytest.raises(LeaseLostError):
        slow.commit_stage(run, output, 10, 0, Decimal(0))
    with pytest.raises(LeaseLostError):
        slow.fail(run, "RUN_FAILED")
    assert checkpoints(admin, run_id) == []
    assert run_row(admin, run_id)["claimed_by"] == "worker-fast"


# --- cancellation ----------------------------------------------------------------------


def test_cancellation_is_checked_between_stages(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None

    def request_cancel() -> None:
        as_end_user(
            admin, run_id, "update echiche.thought_runs set cancel_requested_at = now() where id = %s", (run_id,)
        )

    assert execute(run, store, Scripted(researching=request_cancel), FAST, Event()) is Outcome.CANCELLED
    row = run_row(admin, run_id)
    assert row["status"] == "cancelled" and row["completed_at"] is not None and row["result"] is None
    assert checkpoints(admin, run_id) == ["planning", "researching"]


def test_queued_run_can_be_cancelled_directly_by_its_owner(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    as_end_user(admin, run_id, "update echiche.thought_runs set status = 'cancelled' where id = %s", (run_id,))
    assert run_row(admin, run_id)["status"] == "cancelled"
    assert store_factory().claim() is None


# --- budgets -------------------------------------------------------------------------


def test_budget_pauses_then_explicit_resume_continues(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin, budget_max_steps=2)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None
    assert execute(run, store, DeterministicProvider(), FAST, Event()) is Outcome.PAUSED
    row = run_row(admin, run_id)
    assert (row["status"], row["error_code"], row["steps_used"]) == ("paused_for_budget", "BUDGET_STEPS", 2)
    assert store.claim() is None  # never resumes on its own

    as_end_user(
        admin,
        run_id,
        "update echiche.thought_runs set status = 'queued', budget_max_steps = budget_max_steps + 6 where id = %s",
        (run_id,),
    )
    assert run_row(admin, run_id)["error_code"] is None
    resumed = store.claim()
    assert resumed is not None
    provider = Scripted()
    assert execute(resumed, store, provider, FAST, Event()) is Outcome.AWAITING_REVIEW
    assert provider.calls == ["critiquing", "verifying", "synthesizing"]


def test_wall_time_budget_pauses(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin, budget_max_active_seconds=1)
    admin.execute("update echiche.thought_runs set active_seconds_used = 1 where id = %s", (run_id,))
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None
    assert execute(run, store, DeterministicProvider(), FAST, Event()) is Outcome.PAUSED
    assert run_row(admin, run_id)["error_code"] == "BUDGET_TIME"


# --- provider failures -----------------------------------------------------------------


def test_transient_errors_retry_within_the_claim(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None
    failures = {"n": 0}

    def flaky() -> None:
        failures["n"] += 1
        if failures["n"] <= 2:
            raise TransientProviderError("blip")

    assert execute(run, store, Scripted(planning=flaky), FAST, Event()) is Outcome.AWAITING_REVIEW
    assert run_row(admin, run_id)["attempt"] == 1


def test_provider_timeouts_requeue_with_backoff_then_fail(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    settings = ExecutorSettings(stage_timeout_seconds=0.05, retry=RetryPolicy(max_tries=2, base_seconds=0.001))

    def hang() -> None:
        time.sleep(0.3)

    for attempt in (1, 2):
        run = store.claim()
        assert run is not None and run.attempt == attempt
        assert execute(run, store, Scripted(planning=hang), settings, Event()) is Outcome.REQUEUED
        row = run_row(admin, run_id)
        assert (row["status"], row["error_code"]) == ("queued", "PROVIDER_TIMEOUT")
        assert row["available_at"] > row["updated_at"]  # backoff scheduled in the future
        assert store.claim() is None  # not due yet
        admin.execute("update echiche.thought_runs set available_at = now() where id = %s", (run_id,))

    run = store.claim()
    assert run is not None and run.attempt == 3
    assert execute(run, store, Scripted(planning=hang), settings, Event()) is Outcome.FAILED
    row = run_row(admin, run_id)
    assert (row["status"], row["error_code"]) == ("failed", "PROVIDER_TIMEOUT")


def test_invalid_output_fails_immediately_without_retry(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None
    calls = {"n": 0}

    def malformed() -> None:
        calls["n"] += 1
        raise InvalidProviderOutputError("schema mismatch")

    assert execute(run, store, Scripted(critiquing=malformed), FAST, Event()) is Outcome.FAILED
    assert calls["n"] == 1
    row = run_row(admin, run_id)
    assert (row["status"], row["error_code"]) == ("failed", "INVALID_PROVIDER_OUTPUT")


def test_output_for_the_wrong_stage_is_rejected(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None

    class WrongStage(DeterministicProvider):
        def run_stage(self, stage: Stage, ctx: StageContext) -> StageResult:
            return super().run_stage("planning", ctx)

    store_out = execute(run, store, WrongStage(), FAST, Event())
    assert store_out is Outcome.FAILED  # planning ok, researching returns planning output
    assert run_row(admin, run_id)["error_code"] == "INVALID_PROVIDER_OUTPUT"


def test_unexpected_exceptions_fail_the_run_safely(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None

    def boom() -> None:
        raise RuntimeError("bug")

    assert execute(run, store, Scripted(verifying=boom), FAST, Event()) is Outcome.FAILED
    assert run_row(admin, run_id)["error_code"] == "INTERNAL_ERROR"


def test_claims_beyond_max_attempts_fail(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin, max_attempts=1, attempt=1)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None and run.attempt == 2
    assert execute(run, store, DeterministicProvider(), FAST, Event()) is Outcome.FAILED
    assert run_row(admin, run_id)["error_code"] == "RUN_RETRIES_EXHAUSTED"


def test_graceful_shutdown_releases_without_consuming_an_attempt(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    shutdown = Event()
    run = store.claim()
    assert run is not None
    assert execute(run, store, Scripted(planning=shutdown.set), FAST, shutdown) is Outcome.REQUEUED
    row = run_row(admin, run_id)
    assert (row["status"], row["attempt"], row["error_code"]) == ("queued", 0, "WORKER_SHUTDOWN")
    assert checkpoints(admin, run_id) == ["planning"]  # the in-flight stage finished and was kept


# --- database-enforced state machine ------------------------------------------------


def test_worker_cannot_move_backwards_or_touch_finished_runs(admin: Admin, store_factory: Any, worker_url: str) -> None:
    run_id = create_run(admin, status="critiquing")
    with psycopg.connect(worker_url, autocommit=True) as conn:
        with pytest.raises(psycopg.errors.RaiseException, match="not allowed for the worker"):
            conn.execute("update echiche.thought_runs set status = 'planning' where id = %s", (run_id,))
        with pytest.raises(psycopg.errors.RaiseException):
            conn.execute("update echiche.thought_runs set status = 'awaiting_user_review' where id = %s", (run_id,))
        admin.execute("update echiche.thought_runs set status = 'completed' where id = %s", (run_id,))
        with pytest.raises(psycopg.errors.RaiseException, match="cannot change"):
            conn.execute("update echiche.thought_runs set status = 'failed' where id = %s", (run_id,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("update echiche.thought_runs set prompt = 'rewritten' where id = %s", (run_id,))


@pytest.mark.parametrize(
    ("start", "sql"),
    [
        ("queued", "update echiche.thought_runs set status = 'completed' where id = %s"),
        ("queued", "update echiche.thought_runs set status = 'planning' where id = %s"),
        ("planning", "update echiche.thought_runs set status = 'cancelled' where id = %s"),
        ("awaiting_user_review", "update echiche.thought_runs set status = 'queued' where id = %s"),
        ("queued", "update echiche.thought_runs set budget_max_steps = 999 where id = %s"),
        ("paused_for_budget", "update echiche.thought_runs set status = 'queued', budget_max_steps = 1 where id = %s"),
        ("completed", "update echiche.thought_runs set cancel_requested_at = now() where id = %s"),
    ],
)
def test_end_user_transitions_are_restricted(admin: Admin, start: str, sql: LiteralString) -> None:
    run_id = create_run(admin, status=start)
    with pytest.raises(psycopg.errors.RaiseException):
        as_end_user(admin, run_id, sql, (run_id,))
    assert run_row(admin, run_id)["status"] == start


def test_end_user_cannot_write_results_or_clear_cancellation(admin: Admin) -> None:
    run_id = create_run(admin, status="planning")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_end_user(admin, run_id, "update echiche.thought_runs set result = '{}'::jsonb where id = %s", (run_id,))
    as_end_user(admin, run_id, "update echiche.thought_runs set cancel_requested_at = now() where id = %s", (run_id,))
    with pytest.raises(psycopg.errors.RaiseException):
        as_end_user(
            admin, run_id, "update echiche.thought_runs set cancel_requested_at = null where id = %s", (run_id,)
        )


def test_end_user_accepts_a_reviewed_result(admin: Admin) -> None:
    run_id = create_run(admin, status="awaiting_user_review")
    as_end_user(admin, run_id, "update echiche.thought_runs set status = 'completed' where id = %s", (run_id,))
    row = run_row(admin, run_id)
    assert row["status"] == "completed" and row["completed_at"] is not None


# --- operations ----------------------------------------------------------------------


def test_heartbeats_and_stale_run_visibility(admin: Admin, store_factory: Any) -> None:
    store: RunStore = store_factory("worker-ops")
    store.heartbeat("test", None)
    assert admin.execute(
        "select count(*) as n from echiche.worker_heartbeats where worker_id = 'worker-ops'"
    ).fetchone() == {"n": 1}

    run_id = create_run(admin)
    run = store.claim()
    assert run is not None
    store.begin_stage(run, "planning", "Planning")
    expire_lease(admin, run_id)
    problem = admin.execute("select problem from echiche.ops_run_health where run_id = %s", (run_id,)).fetchone()
    assert problem == {"problem": "lease_expired"}
    store.remove_heartbeat()


def test_cli_once_drains_the_queue_and_exits_cleanly(admin: Admin, worker_url: str) -> None:
    run_ids = [create_run(admin) for _ in range(3)]
    env = {**os.environ, "DATABASE_URL": worker_url, "WORKER_ID": "worker-cli"}
    proc = subprocess.run(  # noqa: S603 - fixed argv, test-only
        [sys.executable, "-m", "echiche_worker", "--once"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert all(run_row(admin, r)["status"] == "awaiting_user_review" for r in run_ids)
    assert "placeholder" not in proc.stdout + proc.stderr
    assert '"event":"worker_stopped"' in proc.stdout


def test_many_workers_drain_many_runs_each_exactly_once(admin: Admin, store_factory: Any) -> None:
    run_ids = [create_run(admin) for _ in range(25)]
    stores = [store_factory(f"worker-{i}") for i in range(8)]
    outcomes: list[Outcome] = []
    lock = threading.Lock()

    def drain(store: RunStore) -> None:
        while (run := store.claim()) is not None:
            outcome = execute(run, store, DeterministicProvider(), FAST, Event())
            with lock:
                outcomes.append(outcome)

    threads = [threading.Thread(target=drain, args=(s,)) for s in stores]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert outcomes == [Outcome.AWAITING_REVIEW] * 25
    rows = admin.execute(
        "select attempt, steps_used, status from echiche.thought_runs where id = any(%s)", (run_ids,)
    ).fetchall()
    assert all(r["attempt"] == 1 and r["steps_used"] == 5 and r["status"] == "awaiting_user_review" for r in rows)
    dupes = admin.execute(
        """select run_id, sequence, count(*) from echiche.run_events where run_id = any(%s)
           group by 1, 2 having count(*) > 1""",
        (run_ids,),
    ).fetchall()
    assert dupes == []


# --- attachments (ADR-012) -------------------------------------------------------------


def _attach(admin: Admin, run_id: str, position: int, kind: str, status: str, **values: object) -> str:
    row = admin.execute(
        """insert into echiche.run_attachments
             (owner_user_id, run_id, position, kind, name, media_type, url, content_sha256, status, extracted_text,
              image_data)
           select owner_user_id, id, %s, %s, %s, %s, %s, %s, %s, %s, %s from echiche.thought_runs where id = %s
           returning id""",
        (
            position,
            kind,
            f"{kind}-{position}",
            values.get("media_type"),
            values.get("url"),
            "a" * 64,
            status,
            values.get("text"),
            values.get("image"),
            run_id,
        ),
    ).fetchone()
    assert row is not None
    return str(row["id"])


def test_worker_loads_attachments_and_records_what_it_read(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    _attach(admin, run_id, 1, "pdf", "ready", text="Runway is 14 months.")
    image = _attach(admin, run_id, 2, "image", "pending", media_type="image/png", image=b"\x89PNG fake")
    link = _attach(admin, run_id, 3, "link", "pending", url="https://example.org/a")
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None

    seen: list[tuple[str, ...]] = []

    class Reader(DeterministicProvider):
        def run_stage(self, stage: Stage, ctx: StageContext) -> StageResult:
            seen.append(tuple(f"{a.ref}:{a.status}" for a in ctx.attachments))
            result = super().run_stage(stage, ctx)
            if stage == "planning":
                assert ctx.attachments[1].image == b"\x89PNG fake"  # bytes available while unread
            return result

    assert execute(run, store, Reader(), FAST, Event()) is Outcome.AWAITING_REVIEW
    # Demo mode marks the image and link unread at planning; later stages see the recorded status.
    assert seen[0] == ("A1:ready", "A2:pending", "A3:pending")
    assert all(s == ("A1:ready", "A2:failed", "A3:failed") for s in seen[1:])
    rows = admin.execute(
        "select id, status, image_data, read_at, note from echiche.run_attachments where run_id = %s order by position",
        (run_id,),
    ).fetchall()
    by_id = {str(r["id"]): r for r in rows}
    for attachment in (image, link):
        assert by_id[attachment]["status"] == "failed" and by_id[attachment]["read_at"] is not None
        assert by_id[attachment]["image_data"] is None and "demo mode" in by_id[attachment]["note"]


def test_worker_cannot_rewrite_attachments_beyond_their_reading_result(admin: Admin, worker_url: str) -> None:
    run_id = create_run(admin)
    attachment = _attach(admin, run_id, 1, "link", "pending", url="https://example.org/a")
    with psycopg.connect(worker_url, autocommit=True) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "update echiche.run_attachments set url = 'https://evil.example/' where id = %s", (attachment,)
            )
    with psycopg.connect(worker_url, autocommit=True) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "insert into echiche.run_attachments"
                " (owner_user_id, run_id, position, kind, name, content_sha256, status)"
                " select owner_user_id, id, 2, 'text', 'x', repeat('a', 64), 'ready'"
                " from echiche.thought_runs where id = %s",
                (run_id,),
            )
