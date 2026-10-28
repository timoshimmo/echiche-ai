"""M5 research persistence against real Postgres as echiche_worker (local TLS fixture site,
scripted search and model; no network)."""

from __future__ import annotations

import json
import ssl
from collections.abc import Iterator
from decimal import Decimal
from threading import Event
from typing import Any

import psycopg
import pytest
from psycopg.rows import DictRow

from echiche_worker.contracts import DecisionBriefV1
from echiche_worker.executor import ExecutorSettings, Outcome, execute
from echiche_worker.retry import RetryPolicy
from echiche_worker.store import RunStore

from .conftest import as_end_user, create_run, run_row
from .model_fakes import FakeModelClient, model_provider
from .research_fakes import (
    FakeSearch,
    FixtureSite,
    brief_citing,
    claims_reply,
    make_tls,
    plan_reply,
    verifier_reply,
)
from .research_fakes import (
    site_fetcher as fetcher_for,
)

pytestmark = [pytest.mark.integration, pytest.mark.usefixtures("clean")]
FAST = ExecutorSettings(stage_timeout_seconds=30, retry=RetryPolicy(max_tries=1, base_seconds=0.001, cap_seconds=0.002))
Admin = psycopg.Connection[DictRow]


class Crash(BaseException):
    pass


@pytest.fixture(scope="module")
def tls(tmp_path_factory: pytest.TempPathFactory) -> tuple[ssl.SSLContext, ssl.SSLContext]:
    return make_tls(tmp_path_factory.mktemp("tls"))


@pytest.fixture
def site(tls: tuple[ssl.SSLContext, ssl.SSLContext]) -> Iterator[FixtureSite]:
    s = FixtureSite(tls)
    yield s
    s.close()


def research_provider(site: FixtureSite, search: FakeSearch, model: FakeModelClient) -> Any:
    from echiche_worker.research_pipeline import ResearchSettings

    return model_provider(model, research=ResearchSettings(search=search, fetcher=fetcher_for(site)))


def model(brief: list[Any] | None = None, claims: list[Any] | None = None) -> FakeModelClient:
    return FakeModelClient(
        script={
            "research_plan_v1": [plan_reply(["clinic scheduling pricing", "paid pilot conversion"])],
            "claim_set_v1": claims or [claims_reply()],
            "claim_verification_v1": [verifier_reply()],
            "decision_brief_v1": brief or [brief_citing(["S1", "S2"])],
        }
    )


def two_queries(site: FixtureSite) -> FakeSearch:
    return FakeSearch([[site.url("survey.test"), site.url("pilots.test")], [site.url("forum.test")]])


def test_research_run_persists_sources_claims_and_telemetry(
    admin: Admin, store_factory: Any, site: FixtureSite
) -> None:
    run_id = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None
    assert (
        execute(run, store, research_provider(site, two_queries(site), model()), FAST, Event())
        is Outcome.AWAITING_REVIEW
    )

    row = run_row(admin, run_id)
    brief = DecisionBriefV1.model_validate(row["result"])
    assert {c.source_id for c in brief.citations} == {"S1", "S2"}
    assert row["research_calls_used"] == 2

    sources = admin.execute(
        "select source_key, url, domain, title, publisher, content_sha256, passages from echiche.sources "
        "where run_id = %s order by source_key",
        (run_id,),
    ).fetchall()
    assert [s["domain"] for s in sources] == ["survey.test", "forum.test", "pilots.test"]
    assert all(s["url"].startswith("https://") and len(s["content_sha256"]) == 64 for s in sources)
    assert all(1 <= len(s["passages"]) <= 3 for s in sources)

    claims = admin.execute(
        "select claim_key, status, contradicted from echiche.claims where run_id = %s order by claim_key", (run_id,)
    ).fetchall()
    assert [c["status"] for c in claims] == ["verified"] * 3 and any(c["contradicted"] for c in claims)
    links = admin.execute(
        """select cs.passage_key, s.source_key, cs.relation, cs.verdict from echiche.claim_sources cs
             join echiche.sources s on s.id = cs.source_id join echiche.claims c on c.id = cs.claim_id
            where c.run_id = %s""",
        (run_id,),
    ).fetchall()
    assert links and all(link["passage_key"].startswith(link["source_key"] + ".") for link in links)
    assert {link["relation"] for link in links} == {"supports", "contradicts"}

    calls = admin.execute(
        "select kind, provider, outcome, cost_usd from echiche.research_calls where run_id = %s", (run_id,)
    ).fetchall()
    assert sum(1 for c in calls if c["kind"] == "search") == 2
    assert {c["kind"] for c in calls} == {"search", "robots", "fetch"}
    search_cost = sum(Decimal(c["cost_usd"]) for c in calls)
    model_cost = admin.execute(
        "select coalesce(sum(cost_usd), 0) as usd from echiche.model_calls where run_id = %s", (run_id,)
    ).fetchone()
    assert model_cost is not None and row["cost_usd_used"] >= search_cost + Decimal(model_cost["usd"]) - Decimal(
        "0.0001"
    )
    assert search_cost == Decimal("0.010")


def test_resume_after_a_crash_does_not_repeat_research_or_duplicate_sources(
    admin: Admin, store_factory: Any, site: FixtureSite
) -> None:
    run_id = create_run(admin)
    search = two_queries(site)

    def crash(_request: Any) -> Any:
        raise Crash

    first_model = model(claims=[crash])
    first: RunStore = store_factory("worker-a", lease_seconds=30)
    run = first.claim()
    assert run is not None
    with pytest.raises(Crash):
        execute(run, first, research_provider(site, search, first_model), FAST, Event())
    assert admin.execute("select count(*) as n from echiche.sources where run_id = %s", (run_id,)).fetchone() == {
        "n": 3
    }
    admin.execute(
        "update echiche.thought_runs set lease_expires_at = now() - interval '1 second' where id = %s", (run_id,)
    )

    second: RunStore = store_factory("worker-b")
    resumed = second.claim()
    assert resumed is not None and resumed.attempt == 2
    assert execute(resumed, second, research_provider(site, search, model()), FAST, Event()) is Outcome.AWAITING_REVIEW
    assert len(search.queries) == 2  # research ran once, in the first attempt
    assert admin.execute("select count(*) as n from echiche.sources where run_id = %s", (run_id,)).fetchone() == {
        "n": 3
    }
    assert admin.execute("select count(*) as n from echiche.claims where run_id = %s", (run_id,)).fetchone() == {"n": 3}


def test_exhausted_research_budget_pauses_before_research(admin: Admin, store_factory: Any, site: FixtureSite) -> None:
    run_id = create_run(admin, budget_max_research_calls=1)
    admin.execute("update echiche.thought_runs set research_calls_used = 1 where id = %s", (run_id,))
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None
    search = two_queries(site)
    assert execute(run, store, research_provider(site, search, model()), FAST, Event()) is Outcome.PAUSED
    row = run_row(admin, run_id)
    assert (row["status"], row["error_code"]) == ("paused_for_budget", "BUDGET_RESEARCH")
    assert search.queries == []


def test_research_rows_are_owner_scoped_and_append_only(
    admin: Admin, store_factory: Any, site: FixtureSite, worker_url: str
) -> None:
    mine = create_run(admin)
    store: RunStore = store_factory()
    run = store.claim()
    assert run is not None
    assert (
        execute(run, store, research_provider(site, two_queries(site), model()), FAST, Event())
        is Outcome.AWAITING_REVIEW
    )
    theirs = create_run(admin)

    owner = str(run_row(admin, mine)["owner_user_id"])
    other = str(run_row(admin, theirs)["owner_user_id"])
    for user, expected in ((owner, 3), (other, 0)):
        with admin.transaction():
            admin.execute("select set_config('request.jwt.claims', %s, true)", (json.dumps({"sub": user}),))
            admin.execute("set local role echiche_end_user")
            counts = admin.execute(
                """select (select count(*) from echiche.sources)::int as s,
                          (select count(*) from echiche.claims)::int as c,
                          (select count(*) from echiche.claim_sources)::int as l,
                          (select count(*) from echiche.research_calls)::int as r"""
            ).fetchone()
        assert counts is not None and counts["s"] == expected and counts["c"] == expected
        assert (counts["l"] > 0) == (expected > 0) and (counts["r"] > 0) == (expected > 0)

    for sql in (
        "update echiche.sources set title = 'x' where run_id = %s",
        "delete from echiche.claims where run_id = %s",
        "insert into echiche.research_calls (owner_user_id, run_id, attempt, kind, provider, outcome, latency_ms) "
        "select owner_user_id, id, 1, 'search', 'brave', 'ok', 1 from echiche.thought_runs where id = %s",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_end_user(admin, mine, sql, (mine,))  # type: ignore[arg-type]
    with psycopg.connect(worker_url, autocommit=True) as conn:
        for sql in ("update echiche.sources set title = 'x' where run_id = %s", "delete from echiche.claim_sources"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(sql, (mine,) if "%s" in sql else ())  # type: ignore[arg-type]
