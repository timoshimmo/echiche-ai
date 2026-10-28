"""M7 adaptive compute: policy loading, tier settings, escalation triggers (no database)."""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from echiche_worker.contracts import (
    CRITIQUE_SCHEMA_VERSION,
    DECISION_FRAME_V2_SCHEMA_VERSION,
    CritiqueV1,
    StageOutputV2,
    VerificationReportV1,
)
from echiche_worker.model_provider import NOT_RUN_CRITIQUE, research_for
from echiche_worker.provider import StageContext
from echiche_worker.research_pipeline import ResearchSettings
from echiche_worker.routing import FULL, RoutingPolicyError, escalation_reasons, load_policy, route_for

from .model_fakes import VALID, FakeModelClient, fixture, model_provider

POLICY = load_policy()


def critique(severity: str) -> CritiqueV1:
    data = fixture("critique.v1")
    for item in [*data["challenged_assumptions"], *data["risks"]]:
        item["severity"] = severity
    return CritiqueV1.model_validate(data)


def report(contradictions: list[str]) -> VerificationReportV1:
    return VerificationReportV1.model_validate(
        {"claims": [], "contradictions": contradictions, "unverifiable": [], "limitations": []}
    )


def test_repo_policy_loads_and_matches_the_web_contract() -> None:
    assert POLICY.version == "routing-policy.v1"
    assert set(POLICY.tiers) == {"low", "medium", "high"}
    low = route_for(POLICY, "low")
    assert (low.research, low.critique, low.verify, low.memory, low.allow_escalation) == (
        False,
        False,
        False,
        True,
        False,
    )
    high = route_for(POLICY, "high")
    assert high.allow_escalation and high.max_queries == 4 and high.max_pages == 8
    assert set(high.triggers) == {"contradiction", "high_severity_critique"}


def test_runs_without_a_tier_get_the_full_pipeline() -> None:
    assert route_for(POLICY, None) is FULL
    assert route_for(None, "low") is FULL  # no policy loaded (e.g. tests): unchanged M6 behaviour
    assert (FULL.research, FULL.critique, FULL.verify, FULL.allow_escalation) == (True, True, True, False)


def test_invalid_policy_files_fail_at_start_up(tmp_path: Path) -> None:
    bad = tmp_path / "p.json"
    bad.write_text("{not json")
    with pytest.raises(RoutingPolicyError):
        load_policy(bad)
    data = json.loads(Path(__file__).resolve().parents[2].joinpath("config/routing-policy.json").read_text())
    del data["tiers"]["medium"]
    bad.write_text(json.dumps(data))
    with pytest.raises(RoutingPolicyError):
        load_policy(bad)
    data = json.loads(Path(__file__).resolve().parents[2].joinpath("config/routing-policy.json").read_text())
    data["escalation"]["triggers"] = ["gut_feeling"]
    bad.write_text(json.dumps(data))
    with pytest.raises(RoutingPolicyError):
        load_policy(bad)


def test_escalation_fires_only_on_configured_triggers_and_only_where_allowed() -> None:
    high, medium = route_for(POLICY, "high"), route_for(POLICY, "medium")
    assert escalation_reasons(high, critique("high"), None) == ["high_severity_critique"]
    assert escalation_reasons(high, critique("medium"), None) == []
    assert escalation_reasons(high, None, report(["C1"])) == ["contradiction"]
    assert escalation_reasons(high, critique("high"), report(["C1"])) == ["contradiction", "high_severity_critique"]
    assert escalation_reasons(medium, critique("high"), report(["C1"])) == []  # tier does not allow it
    assert escalation_reasons(FULL, critique("high"), report(["C1"])) == []


def _synthesis_ctx(route_tier: str | None, critique_data: CritiqueV1 | None, budget: str = "1.00") -> StageContext:
    previous: dict[str, StageOutputV2] = {
        "planning": StageOutputV2(
            stage="planning",
            title="Decision frame",
            content="x",
            data_schema=DECISION_FRAME_V2_SCHEMA_VERSION,
            data=json.loads(VALID["decision_frame_v2"]),
        ),
        "researching": StageOutputV2(stage="researching", title="Skipped", content="x"),
        "verifying": StageOutputV2(stage="verifying", title="Skipped", content="x"),
    }
    if critique_data is None:
        previous["critiquing"] = StageOutputV2(stage="critiquing", title="Skipped (low route)", content="x")
    else:
        previous["critiquing"] = StageOutputV2(
            stage="critiquing",
            title="Critique",
            content="x",
            data_schema=CRITIQUE_SCHEMA_VERSION,
            data=critique_data.model_dump(mode="json"),
        )
    return StageContext(
        run_id="r",
        prompt="Should we sign the exclusive distribution contract?",
        previous=previous,  # type: ignore[arg-type]
        timeout_seconds=5,
        remaining_cost_usd=Decimal(budget),
        route=route_for(POLICY, route_tier),
    )


def test_high_tier_synthesis_escalates_and_records_the_model() -> None:
    main, strong = FakeModelClient(), FakeModelClient(model="gpt-6-astra")
    provider = model_provider(main)
    provider.escalation = strong
    ctx = _synthesis_ctx("high", critique("high"))
    result = provider.run_stage("synthesizing", ctx)
    assert result.escalation == "synthesis escalated to gpt-6-astra (high_severity_critique)"
    assert len(main.requests) == 0 and len(strong.requests) == 1
    assert [c.model for c in ctx.calls] == ["gpt-6-astra-2026-09-01"]  # the reply's model string
    assert ctx.calls[0].provider == "openai"
    # priced at the escalation model's (higher) rate, not the default model's
    cheap = model_provider(FakeModelClient())
    plain = _synthesis_ctx("medium", critique("high"))
    cheap.run_stage("synthesizing", plain)
    assert ctx.calls[0].cost_usd > plain.calls[0].cost_usd


def test_justified_escalation_is_recorded_even_when_not_possible() -> None:
    main = FakeModelClient()
    result = model_provider(main).run_stage("synthesizing", _synthesis_ctx("high", critique("high")))
    assert result.escalation == "escalation triggered (high_severity_critique) but no escalation model is configured"
    assert len(main.requests) == 1

    strong = FakeModelClient(model="gpt-6-astra")
    provider = model_provider(main)
    provider.escalation = strong
    tight = _synthesis_ctx("high", critique("high"), budget="0.15")
    result = provider.run_stage("synthesizing", tight)
    assert result.escalation is not None and "would exceed the remaining spend cap" in result.escalation
    assert len(strong.requests) == 0


def test_no_escalation_without_a_trigger_or_outside_the_high_tier() -> None:
    main, strong = FakeModelClient(), FakeModelClient(model="gpt-6-astra")
    provider = model_provider(main)
    provider.escalation = strong
    assert provider.run_stage("synthesizing", _synthesis_ctx("high", critique("low"))).escalation is None
    assert provider.run_stage("synthesizing", _synthesis_ctx("medium", critique("high"))).escalation is None
    assert provider.run_stage("synthesizing", _synthesis_ctx(None, critique("high"))).escalation is None
    assert len(strong.requests) == 0


def test_synthesis_is_told_when_the_critique_was_not_run() -> None:
    main = FakeModelClient()
    model_provider(main).run_stage("synthesizing", _synthesis_ctx("low", None))
    assert NOT_RUN_CRITIQUE in main.requests[0].data


def test_tier_caps_tighten_but_never_loosen_research_settings() -> None:
    settings = ResearchSettings(search=object(), fetcher=object(), max_queries=3, max_pages=6)  # type: ignore[arg-type]
    medium = StageContext("r", "q", {}, 5, route=route_for(POLICY, "medium"))
    high = StageContext("r", "q", {}, 5, route=route_for(POLICY, "high"))
    full = StageContext("r", "q", {}, 5)
    tightened = research_for(settings, medium.route)
    assert (tightened.max_queries, tightened.max_pages) == (2, 4)
    capped = research_for(settings, high.route)
    assert (capped.max_queries, capped.max_pages) == (3, 6)
    unchanged = research_for(settings, full.route)
    assert (unchanged.max_queries, unchanged.max_pages) == (3, 6)
