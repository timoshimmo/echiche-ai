"""Research -> verification -> grounded brief, end to end without a database or network.

Adversarial fixtures (worker/tests/fixtures/research): a contradicting forum poll, a 2014
article (stale), a page with hidden prompt-injection text, a noarchive/noai page; plus
no-results, invalid URLs, unsupported and mis-quoted claims, budget limits and provider failure.
"""

from __future__ import annotations

import json
import ssl
import time
from collections.abc import Iterator
from decimal import Decimal
from typing import Any, cast

import pytest

from echiche_worker.compose import compose_final
from echiche_worker.contracts import (
    STAGES,
    DecisionBriefV1,
    DecisionFrameV1,
    EvidenceSetV1,
    Stage,
    StageOutput,
    VerificationReportV1,
)
from echiche_worker.provider import BudgetPreflightError, ResearchCallRecord, StageContext
from echiche_worker.research import ResearchAuthError, ResearchUnavailableError, SearchCallError
from echiche_worker.research_pipeline import NO_SOURCES, ResearchSettings, gather_evidence

from .model_fakes import VALID, FakeModelClient, fixture, model_provider
from .research_fakes import (
    FakeSearch,
    FixtureSite,
    Script,
    brief_citing,
    claims_reply,
    make_tls,
    plan_reply,
    site_fetcher,
    verifier_reply,
)

QUESTION = "Should we run a paid pilot with three clinics this quarter?"


@pytest.fixture(scope="module")
def tls(tmp_path_factory: pytest.TempPathFactory) -> tuple[ssl.SSLContext, ssl.SSLContext]:
    return make_tls(tmp_path_factory.mktemp("tls"))


@pytest.fixture
def site(tls: tuple[ssl.SSLContext, ssl.SSLContext]) -> Iterator[FixtureSite]:
    s = FixtureSite(tls)
    yield s
    s.close()


def settings(site: FixtureSite, search: FakeSearch, **overrides: Any) -> ResearchSettings:
    values: dict[str, Any] = {"max_queries": 3, "results_per_query": 5, "max_pages": 6, "stale_days": 730}
    values.update(overrides)
    return ResearchSettings(search=search, fetcher=site_fetcher(site), **values)


def client(
    brief: list[Any] | None = None, claims: list[Any] | None = None, verdicts: list[Any] | None = None
) -> FakeModelClient:
    return FakeModelClient(
        script={
            "research_plan_v1": [plan_reply(["clinic scheduling software pricing", "paid pilot conversion clinics"])],
            "claim_set_v1": claims or [claims_reply()],
            "claim_verification_v1": verdicts or [verifier_reply()],
            "decision_brief_v1": brief or [],
        }
    )


def run(
    research: ResearchSettings | None,
    model: FakeModelClient,
    research_calls: int = 8,
    final_attempt: bool = False,
    budget: str = "5.00",
) -> tuple[dict[Stage, StageOutput], list[StageContext]]:
    provider = model_provider(model, research=research)
    outputs: dict[Stage, StageOutput] = {}
    contexts: list[StageContext] = []
    used = 0
    for stage in STAGES:
        ctx = StageContext(
            run_id="r",
            prompt=QUESTION,
            previous=dict(outputs),
            timeout_seconds=60,
            project_context="Project title: Acme\n\nProblem statement:\nScheduling software for small clinics.",
            remaining_cost_usd=Decimal(budget),
            remaining_research_calls=research_calls - used,
            final_attempt=final_attempt,
        )
        result = provider.run_stage(stage, ctx)
        used += result.research_calls
        outputs[stage] = result.output
        contexts.append(ctx)
    return outputs, contexts


def _data(output: StageOutput) -> object:
    return cast(Any, output).data


def evidence_of(outputs: dict[Stage, StageOutput]) -> EvidenceSetV1:
    return EvidenceSetV1.model_validate(_data(outputs["researching"]))


def report_of(outputs: dict[Stage, StageOutput]) -> VerificationReportV1:
    return VerificationReportV1.model_validate(_data(outputs["verifying"]))


def brief_of(outputs: dict[Stage, StageOutput]) -> DecisionBriefV1:
    version, result = compose_final(QUESTION, outputs)
    assert version == "decision-brief.v1" and isinstance(result, DecisionBriefV1)
    return result


# --- happy path with conflict and staleness ---------------------------------------------------


def test_research_reads_pages_verifies_claims_and_grounds_the_brief(site: FixtureSite) -> None:
    search = FakeSearch(
        [
            [site.url("survey.test"), site.url("pilots.test")],
            [site.url("forum.test"), site.url("archive.test"), site.url("survey.test")],  # duplicate URL
        ]
    )
    model = client(brief=[brief_citing(["S1", "S2"], confidence="high")])
    outputs, contexts = run(settings(site, search), model)

    evidence = evidence_of(outputs)
    assert [s.domain for s in evidence.sources] == ["survey.test", "forum.test", "pilots.test", "archive.test"]
    assert [s.source_id for s in evidence.sources] == ["S1", "S2", "S3", "S4"]
    assert all(1 <= len(s.passages) <= 3 and all(len(p.text) <= 600 for p in s.passages) for s in evidence.sources)
    assert evidence.sources[0].publisher == "Clinic Operations Review"
    assert len(search.queries) == 2 and contexts[1].research_calls  # searches + robots + fetches recorded
    assert sum(1 for r in contexts[1].research_calls if r.kind == "search") == 2
    assert outputs["researching"].limitations == []

    report = report_of(outputs)
    assert {c.status for c in report.claims} == {"verified"}
    conflict = next(c for c in report.claims if len(c.evidence) == 2)
    assert conflict.claim_id in report.contradictions
    stale = next(c for c in report.claims if c.evidence[0].source_id == "S4")
    assert stale.freshness == "stale"
    assert any("older than 730 days" in note for note in report.limitations)
    assert any("Sources disagree" in note for note in report.limitations)

    brief = brief_of(outputs)
    assert {c.source_id for c in brief.citations} == {"S1", "S2"}
    assert any("Sources disagree" in note for note in brief.limitations)  # carried verbatim into the brief
    synth = [c for c in contexts[4].calls]
    assert [c.outcome for c in synth] == ["ok"]


# --- no results ---------------------------------------------------------------------------------


def test_no_results_says_research_was_insufficient_and_blocks_citations(site: FixtureSite) -> None:
    search = FakeSearch([[], []])
    model = client(brief=[brief_citing(["S1"]), VALID["decision_brief_v1"]])
    outputs, contexts = run(settings(site, search), model)
    evidence = evidence_of(outputs)
    assert evidence.sources == [] and NO_SOURCES in evidence.limitations
    assert [s.status for s in evidence.searches] == ["no_results", "no_results"]
    assert contexts[3].calls == []  # nothing to verify: no claim extraction, no verifier call
    synth = contexts[4].calls
    assert [(c.outcome, c.repair) for c in synth] == [("invalid_output", False), ("ok", True)]  # invented citation
    brief = brief_of(outputs)
    assert brief.citations == [] and NO_SOURCES in brief.limitations


# --- invalid URLs and refused pages ------------------------------------------------------------------


def test_invalid_and_refused_urls_never_become_sources(site: FixtureSite) -> None:
    search = FakeSearch(
        [
            [
                "ftp://survey.test/file",
                f"https://user:pw@survey.test:{site.port}/clinic-survey.html",
                site.url("forum.test").replace("https://", "http://"),
                site.url("members.test"),  # noarchive, noai
                site.url("pilots.test", "/private/page"),  # robots.txt
                site.url("archive.test", "/pdf"),
            ]
        ]
    )
    outputs, _ = run(settings(site, search, max_queries=1, results_per_query=10), client())
    evidence = evidence_of(outputs)
    assert evidence.sources == []
    statuses = sorted(s.status for s in evidence.skipped)
    assert statuses == [
        "blocked_publisher", "blocked_robots", "unsupported_type", "unsupported_url", "unsupported_url",
        "unsupported_url",
    ]  # fmt: skip


# --- unsupported and mis-quoted claims -----------------------------------------------------------------


def test_misquoted_and_unsupported_claims_cannot_be_cited(site: FixtureSite) -> None:
    def misquote(claims: list[dict[str, Any]], _sources: list[dict[str, Any]]) -> None:
        claims[0]["evidence"][0]["quote"] = "eighty percent of clinics refuse to pay for any software"

    search = FakeSearch([[site.url("survey.test"), site.url("pilots.test")]])
    model = client(
        claims=[claims_reply(misquote)],
        verdicts=[verifier_reply({"C2": "not_supported"})],
        brief=[brief_citing(["S1"]), VALID["decision_brief_v1"]],
    )
    outputs, contexts = run(settings(site, search, max_queries=1), model)
    report = report_of(outputs)
    assert [(c.claim_id, c.status, c.label) for c in report.claims] == [
        ("C1", "invalid", "inference"),  # quote not found in the passage; "fact" downgraded
        ("C2", "unsupported", "inference"),  # independent verifier: not supported
    ]
    assert report.claims[0].evidence[0].verdict == "quote_not_found"
    verifier_request = next(r for r in model.requests if r.schema_name == "claim_verification_v1")
    assert '"claim_id": "C1"' not in verifier_request.data  # mis-quoted pairs are not even sent for judgment
    # Nothing is citable, so the brief must drop the citation (repair), and still fails a second time.
    synth = contexts[4].calls  # nothing is citable: the brief citing S1 is rejected, then repaired
    assert [c.outcome for c in synth] == ["invalid_output", "ok"]
    assert brief_of(outputs).citations == []


# --- prompt injection in a fetched page ---------------------------------------------------------------


def test_injected_page_text_stays_data_and_cannot_create_citations(site: FixtureSite) -> None:
    def obey_injection(claims: list[dict[str, Any]], _sources: list[dict[str, Any]]) -> None:
        claims[0]["evidence"].append({"passage_id": "S9.p1", "relation": "supports", "quote": "guarantees 95 percent"})

    search = FakeSearch([[site.url("pricing.test"), site.url("survey.test")]])
    model = client(
        claims=[claims_reply(obey_injection), claims_reply()],
        brief=[brief_citing(["S9"], confidence="high"), brief_citing(["S1", "S2"])],
    )
    outputs, contexts = run(settings(site, search, max_queries=1), model)
    evidence = evidence_of(outputs)
    injected = [p.text for s in evidence.sources for p in s.passages if "SYSTEM OVERRIDE" in p.text]
    for request in model.requests:
        assert "SYSTEM OVERRIDE" not in request.instructions  # web text never reaches instructions
    if injected:
        critic = next(r for r in model.requests if r.schema_name == "critique_v1")
        assert "SYSTEM OVERRIDE" in critic.data and "&lt;/untrusted" in critic.data  # fenced and escaped
    extraction = [c for c in contexts[3].calls if c.prompt_id == "claim-extractor"]
    assert [(c.outcome, c.repair) for c in extraction] == [("invalid_output", False), ("ok", True)]
    repair = [r for r in model.requests if r.schema_name == "claim_set_v1"][1]
    assert "S9.p1" in repair.instructions and "guarantees" not in repair.instructions
    synth = contexts[4].calls
    assert [c.outcome for c in synth] == ["invalid_output", "ok"]  # S9 was never supplied
    assert {c.source_id for c in brief_of(outputs).citations} == {"S1", "S2"}


def test_high_confidence_needs_two_independent_domains(site: FixtureSite) -> None:
    search = FakeSearch([[site.url("survey.test"), site.url("pilots.test")]])
    model = client(brief=[brief_citing(["S1"], confidence="high"), brief_citing(["S1", "S2"], confidence="high")])
    outputs, contexts = run(settings(site, search, max_queries=1), model)
    synth = contexts[4].calls
    assert [(c.outcome, c.repair) for c in synth] == [("invalid_output", False), ("ok", True)]
    repair = [r for r in model.requests if r.schema_name == "decision_brief_v1"][1]
    assert "two independent" in repair.instructions
    assert brief_of(outputs).confidence.level == "high"


# --- limits, budget and provider failure --------------------------------------------------------


def test_search_count_is_bounded_by_the_runs_research_budget(site: FixtureSite) -> None:
    search = FakeSearch([[site.url("survey.test")], [site.url("pilots.test")]])
    outputs, contexts = run(settings(site, search), client(), research_calls=1)
    assert len(search.queries) == 1
    plan_request = next(r for r in contexts[1].calls if r.prompt_id == "research-planner")
    assert plan_request.outcome == "ok"
    assert len(evidence_of(outputs).searches) == 1

    search_none = FakeSearch()
    outputs, _ = run(settings(site, search_none), client(), research_calls=0)
    assert search_none.queries == [] and "allows no searches" in evidence_of(outputs).limitations[0]


def test_page_count_is_bounded(site: FixtureSite) -> None:
    urls = [site.url(h) for h in ("survey.test", "pilots.test", "forum.test", "archive.test")]
    outputs, _ = run(settings(site, FakeSearch([urls]), max_queries=1, max_pages=2), client())
    assert len(evidence_of(outputs).sources) == 2


def _failing(error: Exception) -> SearchCallError:
    record = ResearchCallRecord("search", "brave", "http_error", 503, None, 0, 0, Decimal("0.005"), 5)
    return SearchCallError(error, record)  # type: ignore[arg-type]


def test_search_outage_retries_then_degrades_explicitly_on_the_last_attempt(site: FixtureSite) -> None:
    provider = model_provider(
        client(), research=settings(site, FakeSearch([_failing(ResearchUnavailableError("down"))]))
    )
    frame_output = run(None, FakeModelClient())[0]["planning"]
    ctx = StageContext(
        run_id="r", prompt=QUESTION, previous={"planning": frame_output}, timeout_seconds=30,
        remaining_cost_usd=Decimal(5), remaining_research_calls=8, final_attempt=False,
    )  # fmt: skip
    with pytest.raises(ResearchUnavailableError):
        provider.run_stage("researching", ctx)
    assert any(r.kind == "search" for r in ctx.research_calls)  # the failed call is still recorded

    down: list[Script] = [_failing(ResearchUnavailableError("down")), _failing(ResearchUnavailableError("down"))]
    outputs, _ = run(settings(site, FakeSearch(down)), client(), final_attempt=True)
    evidence = evidence_of(outputs)
    assert [s.status for s in evidence.searches] == ["failed", "failed"]
    assert any("unavailable" in note for note in evidence.limitations) and NO_SOURCES in evidence.limitations


def test_a_rejected_search_key_fails_the_run_even_on_the_last_attempt(site: FixtureSite) -> None:
    with pytest.raises(ResearchAuthError):
        run(settings(site, FakeSearch([_failing(ResearchAuthError("bad key"))])), client(), final_attempt=True)


def test_search_spend_is_checked_before_each_search(site: FixtureSite) -> None:
    frame = DecisionFrameV1.model_validate(fixture("decision-frame.v1"))
    ctx = StageContext(
        run_id="r", prompt=QUESTION, previous={}, timeout_seconds=30,
        remaining_cost_usd=Decimal("0.001"), remaining_research_calls=8,
    )  # fmt: skip
    search = FakeSearch([[site.url("survey.test")]])
    with pytest.raises(BudgetPreflightError):
        gather_evidence(settings(site, search), ctx, frame, lambda n: ["clinic pricing"][:n], time.monotonic() + 30)
    assert search.queries == []


def test_without_a_research_provider_research_is_skipped_and_disclosed() -> None:
    outputs, contexts = run(None, FakeModelClient())
    assert outputs["researching"].limitations and "No research provider" in outputs["researching"].limitations[0]
    assert contexts[3].calls == [] and json.loads("[]") == []
    brief = brief_of(outputs)
    assert any("No research provider" in note for note in brief.limitations)
