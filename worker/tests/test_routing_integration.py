"""M7 routing against real Postgres as echiche_worker: tiers shape the pipeline, escalation is recorded."""

from __future__ import annotations

from decimal import Decimal
from threading import Event
from typing import Any

import psycopg
import pytest
from psycopg.rows import DictRow

from echiche_worker.contracts import DecisionBriefV1
from echiche_worker.executor import ExecutorSettings, Outcome, execute
from echiche_worker.provider import DeterministicProvider
from echiche_worker.retry import RetryPolicy
from echiche_worker.routing import QUICK_ROUTE_LIMITATION, load_policy
from echiche_worker.store import RunStore

from .conftest import create_run, run_row
from .model_fakes import FakeModelClient, model_provider

pytestmark = [pytest.mark.integration, pytest.mark.usefixtures("clean")]
Admin = psycopg.Connection[DictRow]
ROUTED = ExecutorSettings(
    stage_timeout_seconds=5,
    retry=RetryPolicy(max_tries=1, base_seconds=0.001, cap_seconds=0.002),
    routing=load_policy(),
)


def run_once(store: RunStore, provider: Any) -> Outcome:
    run = store.claim()
    assert run is not None
    return execute(run, store, provider, ROUTED, Event())


def calls_of(admin: Admin, run_id: str) -> list[DictRow]:
    return admin.execute(
        "select stage, model, outcome from echiche.model_calls where run_id = %s order by created_at, id", (run_id,)
    ).fetchall()


def test_low_tier_skips_research_critique_and_verification(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(
        admin,
        route_tier="low",
        requested_depth="quick",
        route_policy_version="routing-policy.v1",
        budget_max_steps=5,
        budget_max_research_calls=0,
    )
    client = FakeModelClient()
    assert run_once(store_factory(), model_provider(client)) is Outcome.AWAITING_REVIEW

    row = run_row(admin, run_id)
    assert row["steps_used"] == 5 and row["research_calls_used"] == 0
    assert [(c["stage"], c["outcome"]) for c in calls_of(admin, run_id)] == [
        ("planning", "ok"),
        ("synthesizing", "ok"),
    ]
    brief = DecisionBriefV1.model_validate(row["result"])
    assert QUICK_ROUTE_LIMITATION in brief.limitations  # the user is told what was left out
    titles = {
        r["stage"]: r["title"]
        for r in admin.execute(
            "select stage, output->>'title' as title from echiche.run_stage_outputs where run_id = %s", (run_id,)
        ).fetchall()
    }
    assert titles["researching"] == titles["critiquing"] == titles["verifying"] == "Skipped (low route)"
    assert row["route_escalation"] is None


def test_high_tier_escalates_synthesis_and_records_why(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(
        admin, route_tier="high", route_policy_version="routing-policy.v1", budget_max_cost_usd=Decimal("1.00")
    )
    main, strong = FakeModelClient(), FakeModelClient(model="gpt-6-astra")
    provider = model_provider(main)
    provider.escalation = strong  # the critique fixture rates an assumption 'high'
    assert run_once(store_factory(), provider) is Outcome.AWAITING_REVIEW

    row = run_row(admin, run_id)
    assert row["route_escalation"] == "synthesis escalated to gpt-6-astra (high_severity_critique)"
    assert [(c["stage"], c["model"]) for c in calls_of(admin, run_id)] == [
        ("planning", "gpt-6.1-sol-2026-09-01"),
        ("critiquing", "gpt-6.1-sol-2026-09-01"),
        ("synthesizing", "gpt-6-astra-2026-09-01"),
    ]
    messages = [
        r["message"]
        for r in admin.execute("select message from echiche.run_events where run_id = %s", (run_id,)).fetchall()
    ]
    assert "Route: synthesis escalated to gpt-6-astra (high_severity_critique)" in messages


def test_medium_tier_never_escalates(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin, route_tier="medium", route_policy_version="routing-policy.v1")
    strong = FakeModelClient(model="gpt-6-astra")
    provider = model_provider(FakeModelClient())
    provider.escalation = strong
    assert run_once(store_factory(), provider) is Outcome.AWAITING_REVIEW
    assert run_row(admin, run_id)["route_escalation"] is None and strong.requests == []


def test_runs_queued_before_routing_run_the_full_pipeline(admin: Admin, store_factory: Any) -> None:
    run_id = create_run(admin)  # route_tier is null, as for every pre-M7 run
    assert run_once(store_factory(), DeterministicProvider()) is Outcome.AWAITING_REVIEW
    titles = [
        r["title"]
        for r in admin.execute(
            "select output->>'title' as title from echiche.run_stage_outputs where run_id = %s", (run_id,)
        ).fetchall()
    ]
    assert len(titles) == 5 and not any(t.startswith("Skipped") for t in titles)


def test_worker_cannot_change_the_route_decision(admin: Admin, worker_url: str) -> None:
    run_id = create_run(admin, route_tier="low")
    with psycopg.connect(worker_url) as conn, pytest.raises(psycopg.errors.InsufficientPrivilege):
        conn.execute("update echiche.thought_runs set route_tier = 'high' where id = %s", (run_id,))
