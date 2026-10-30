"""M4 model pipeline against real Postgres as echiche_worker, with a scripted model client."""

from __future__ import annotations

import json
from decimal import Decimal
from threading import Event
from typing import Any

import psycopg
import pytest
from psycopg.rows import DictRow

from echiche_worker.contracts import STAGES, DecisionBriefV1
from echiche_worker.executor import ExecutorSettings, Outcome, execute
from echiche_worker.llm import ModelCallError, TokenUsage
from echiche_worker.provider import DeterministicProvider, ProviderRateLimitedError
from echiche_worker.retry import RetryPolicy
from echiche_worker.store import RunStore, spend

from .conftest import as_end_user, create_run, run_row
from .model_fakes import FakeModelClient, model_provider

pytestmark = [pytest.mark.integration, pytest.mark.usefixtures("clean")]

FAST = ExecutorSettings(stage_timeout_seconds=5, retry=RetryPolicy(max_tries=2, base_seconds=0.001, cap_seconds=0.002))
Admin = psycopg.Connection[DictRow]


def calls_of(admin: Admin, run_id: str) -> list[DictRow]:
    return admin.execute(
        "select * from echiche.model_calls where run_id = %s order by created_at, id", (run_id,)
    ).fetchall()


def run_once(store: RunStore, client: FakeModelClient | None = None) -> Outcome:
    run = store.claim()
    assert run is not None
    return execute(run, store, model_provider(client), FAST, Event())


def test_model_run_stores_a_decision_brief_and_call_telemetry(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    client = FakeModelClient()
    assert run_once(store_factory(), client) is Outcome.AWAITING_REVIEW

    row = run_row(admin, run_id)
    assert row["result_schema_version"] == "decision-brief.v1"
    DecisionBriefV1.model_validate(row["result"])
    # the project's problem statement reached the framing call (as fenced data)
    assert "A synthetic decision for worker tests." in client.requests[0].data

    calls = calls_of(admin, run_id)
    assert [(c["stage"], c["outcome"], c["prompt_version"]) for c in calls] == [
        ("planning", "ok", "2.2.0"),
        ("critiquing", "ok", "2.2.0"),
        ("synthesizing", "ok", "2.4.0"),
    ]
    assert all(len(c["prompt_sha256"]) == 64 and c["provider"] == "openai" for c in calls)
    expected = sum(spend(Decimal(c["cost_usd"])) for c in calls)
    assert row["cost_usd_used"] == expected and expected > 0

    stored = admin.execute(
        "select stage, output_schema_version, output->>'data_schema' as data_schema from echiche.run_stage_outputs "
        "where run_id = %s",
        (run_id,),
    ).fetchall()
    assert {r["output_schema_version"] for r in stored} == {"stage-output.v2"}
    assert {r["stage"]: r["data_schema"] for r in stored} == {
        "planning": "decision-frame.v2",
        "researching": None,
        "critiquing": "critique.v1",
        "verifying": None,
        "synthesizing": "decision-brief.v1",
    }


def test_failed_calls_still_count_against_the_budget(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    client = FakeModelClient(script={"decision_brief_v1": ["not json", "{}"]})
    assert run_once(store_factory(), client) is Outcome.FAILED
    row = run_row(admin, run_id)
    assert (row["status"], row["error_code"]) == ("failed", "INVALID_PROVIDER_OUTPUT")
    calls = calls_of(admin, run_id)
    assert [c["outcome"] for c in calls if c["stage"] == "synthesizing"] == ["invalid_output", "invalid_output"]
    assert [c["repair"] for c in calls if c["stage"] == "synthesizing"] == [False, True]
    assert row["cost_usd_used"] >= sum(Decimal(c["cost_usd"]) for c in calls)


def test_spend_cap_pauses_before_the_call_and_resume_continues(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin, budget_max_cost_usd=Decimal("0.0200"))
    store: RunStore = store_factory()
    client = FakeModelClient()
    assert run_once(store, client) is Outcome.PAUSED
    row = run_row(admin, run_id)
    assert (row["status"], row["error_code"]) == ("paused_for_budget", "BUDGET_COST")
    sent_before = len(client.requests)

    as_end_user(
        admin,
        run_id,
        "update echiche.thought_runs set status = 'queued', budget_max_cost_usd = 1.00 where id = %s",
        (run_id,),
    )
    assert run_once(store, client) is Outcome.AWAITING_REVIEW
    assert len(client.requests) == 3  # each stage called once in total: no stage re-ran
    assert sent_before < 3


def test_rate_limit_retry_after_delays_the_requeue(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    limited = ModelCallError(ProviderRateLimitedError("429", retry_after=120), TokenUsage())
    client = FakeModelClient(script={"decision_frame_v2": [limited, limited]})
    assert run_once(store_factory(), client) is Outcome.REQUEUED
    row = admin.execute(
        "select status, error_code, available_at > now() + interval '100 seconds' as delayed "
        "from echiche.thought_runs where id = %s",
        (run_id,),
    ).fetchone()
    assert row is not None and (row["status"], row["error_code"], row["delayed"]) == (
        "queued",
        "PROVIDER_RATE_LIMITED",
        True,
    )
    assert [c["error_code"] for c in calls_of(admin, run_id)] == ["PROVIDER_RATE_LIMITED"] * 2


def test_m3_checkpoints_still_load_and_mode_switches_fail_safely(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    owner = run_row(admin, run_id)["owner_user_id"]
    admin.execute(
        """insert into echiche.run_stage_outputs (run_id, owner_user_id, stage, output, output_schema_version,
                                                  attempt, duration_ms)
           values (%s, %s, 'planning', %s::jsonb, 'stage-output.v1', 1, 5)""",
        (run_id, owner, json.dumps({"stage": "planning", "title": "Frame", "content": "Old M3 checkpoint."})),
    )
    store: RunStore = store_factory()
    assert run_once(store, FakeModelClient()) is Outcome.FAILED  # demo checkpoint cannot feed the model pipeline
    assert run_row(admin, run_id)["error_code"] == "REASONING_MODE_MISMATCH"

    second = create_run(admin)
    admin.execute(
        """insert into echiche.run_stage_outputs (run_id, owner_user_id, stage, output, output_schema_version,
                                                  attempt, duration_ms)
           values (%s, %s, 'planning', %s::jsonb, 'stage-output.v1', 1, 5)""",
        (
            second,
            run_row(admin, second)["owner_user_id"],
            json.dumps({"stage": "planning", "title": "F", "content": "c"}),
        ),
    )
    run = store.claim()
    assert run is not None and run.id == second
    assert execute(run, store, DeterministicProvider(), FAST, Event()) is Outcome.AWAITING_REVIEW
    assert len(store.load_checkpoints(second)) == len(STAGES)


def test_corrupt_model_payload_in_a_checkpoint_is_rejected(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)
    bad = {"stage": "planning", "title": "t", "content": "c", "data_schema": "decision-frame.v1", "data": {"x": 1}}
    admin.execute(
        """insert into echiche.run_stage_outputs (run_id, owner_user_id, stage, output, output_schema_version,
                                                  attempt, duration_ms)
           values (%s, %s, 'planning', %s::jsonb, 'stage-output.v2', 1, 5)""",
        (run_id, run_row(admin, run_id)["owner_user_id"], json.dumps(bad)),
    )
    assert run_once(store_factory()) is Outcome.FAILED
    assert run_row(admin, run_id)["error_code"] == "CHECKPOINT_INVALID"


def test_model_calls_are_owner_scoped_and_append_only(admin: Admin, store_factory: Any, worker_url: str) -> None:
    mine = create_run(admin)
    assert run_once(store_factory()) is Outcome.AWAITING_REVIEW
    theirs = create_run(admin)
    assert run_once(store_factory()) is Outcome.AWAITING_REVIEW

    owner = str(run_row(admin, mine)["owner_user_id"])
    with admin.transaction():
        admin.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": owner}),))
        admin.execute("set local role echiche_end_user")
        visible = admin.execute("select distinct run_id from echiche.model_calls").fetchall()
    assert [str(r["run_id"]) for r in visible] == [mine]  # RLS hides the other user's calls
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_end_user(admin, mine, "delete from echiche.model_calls where run_id = %s", (mine,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_end_user(admin, mine, "update echiche.model_calls set cost_usd = 0 where run_id = %s", (mine,))

    with psycopg.connect(worker_url, autocommit=True) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("update echiche.model_calls set cost_usd = 0 where run_id = %s", (theirs,))
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("delete from echiche.model_calls where run_id = %s", (theirs,))
        admin.execute("update echiche.thought_runs set status = 'critiquing' where id = %s", (theirs,))
        with pytest.raises(psycopg.errors.RaiseException, match="cannot decrease"):
            conn.execute("update echiche.thought_runs set cost_usd_used = 0 where id = %s", (theirs,))
