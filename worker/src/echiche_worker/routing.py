"""Adaptive compute (M7, ADR-010): how the worker shapes a run from the router's tier.

The web app classifies each run when it is queued (src/lib/domain/routing.ts) and stores the
tier, the reasons and the policy version on the run. The worker reads the *same* versioned
policy file (config/routing-policy.json) to decide which stages run, how much research is
allowed, and whether synthesis may escalate to a stronger model. Everything here is
deterministic and explainable: no trained router, no model-judged routing, no debate loops.

Runs queued before M7 have no tier and run the full pipeline with the operator's research
settings and no escalation (`FULL`), exactly as they did before.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from echiche_worker.contracts import CritiqueV1, VerificationReportV1

Tier = Literal["low", "medium", "high"]
Trigger = Literal["contradiction", "high_severity_critique"]


class _Loose(BaseModel):
    # The web app validates the signals and thresholds strictly; the worker only needs tiers
    # and escalation, so unknown keys elsewhere in the file are ignored here.
    model_config = ConfigDict(extra="ignore", frozen=True)


class TierPipeline(_Loose):
    research: bool
    critique: bool
    verify: bool
    memory: bool
    allow_escalation: bool


class TierResearch(_Loose):
    max_queries: int = Field(ge=0, le=8)
    max_pages: int = Field(ge=0, le=12)


class TierPolicy(_Loose):
    label: str
    pipeline: TierPipeline
    research: TierResearch


class EscalationPolicy(_Loose):
    triggers: list[Trigger] = Field(min_length=1)


class RoutingPolicy(_Loose):
    version: str = Field(pattern=r"^routing-policy\.v[0-9]+$")
    tiers: dict[Tier, TierPolicy]
    escalation: EscalationPolicy


class RoutingPolicyError(Exception):
    code = "CONFIG_INVALID"


def default_policy_path() -> Path:
    configured = os.environ.get("ECHICHE_ROUTING_POLICY", "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[3] / "config" / "routing-policy.json"


def load_policy(path: Path | None = None) -> RoutingPolicy:
    target = path or default_policy_path()
    try:
        policy = RoutingPolicy.model_validate(json.loads(target.read_text(encoding="utf-8")))
    except (OSError, ValueError, ValidationError) as error:
        raise RoutingPolicyError(f"routing policy {target.name}: {type(error).__name__}") from error
    if set(policy.tiers) != {"low", "medium", "high"}:
        raise RoutingPolicyError("routing policy must define the low, medium and high tiers")
    return policy


@dataclass(frozen=True, slots=True)
class RouteSettings:
    """What this run is allowed to do. None for a research cap = use the operator's setting."""

    tier: Tier | None
    research: bool = True
    critique: bool = True
    verify: bool = True
    memory: bool = True
    allow_escalation: bool = False
    max_queries: int | None = None
    max_pages: int | None = None
    triggers: tuple[Trigger, ...] = ()

    @property
    def label(self) -> str:
        return self.tier or "full"


FULL = RouteSettings(tier=None)


def route_for(policy: RoutingPolicy | None, tier: str | None) -> RouteSettings:
    if policy is None or tier not in ("low", "medium", "high"):
        return FULL
    t = policy.tiers[tier]  # type: ignore[index]  # narrowed by the check above
    return RouteSettings(
        tier=tier,  # type: ignore[arg-type]
        research=t.pipeline.research,
        critique=t.pipeline.critique,
        verify=t.pipeline.verify,
        memory=t.pipeline.memory,
        allow_escalation=t.pipeline.allow_escalation,
        max_queries=t.research.max_queries,
        max_pages=t.research.max_pages,
        triggers=tuple(policy.escalation.triggers),
    )


def escalation_reasons(
    route: RouteSettings, critique: CritiqueV1 | None, report: VerificationReportV1 | None
) -> list[Trigger]:
    """Which configured triggers fired (deterministic; empty unless the tier allows escalation)."""
    if not route.allow_escalation:
        return []
    fired: list[Trigger] = []
    if "contradiction" in route.triggers and report is not None and report.contradictions:
        fired.append("contradiction")
    if "high_severity_critique" in route.triggers and critique is not None:
        severities = [a.severity for a in critique.challenged_assumptions] + [r.severity for r in critique.risks]
        if "high" in severities:
            fired.append("high_severity_critique")
    return fired


SKIPPED_STAGE_TEXT = {
    "researching": "Quick route: no web research was run for this question.",
    "critiquing": "Quick route: no separate critique was run.",
    "verifying": "Quick route: no claims were verified, because no research was run.",
}
QUICK_ROUTE_LIMITATION = (
    "This was a quick run: it was not researched, critiqued or verified. "
    "Ask for a standard or deep run if this decision matters."
)
