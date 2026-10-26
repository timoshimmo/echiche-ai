"""Worker-owned payload contracts (ADR-001 D1, ADR-003).

Pydantic models here are the source of truth. Their JSON Schemas are committed in
``contracts/`` at the repo root; the web app validates stored payloads against the
same shapes. Regenerate after any change and commit the result:

    uv run python -m echiche_worker.contracts --write    # regenerate
    uv run python -m echiche_worker.contracts --check    # CI: fail if stale
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

Stage = Literal["planning", "researching", "critiquing", "verifying", "synthesizing"]
STAGES: tuple[Stage, ...] = ("planning", "researching", "critiquing", "verifying", "synthesizing")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# --- Final run result (stored in thought_runs.result) -----------------------------

RESULT_SCHEMA_VERSION = "reasoning-scaffold.v1"


class ReasoningStageV1(_Strict):
    stage: Literal["frame", "challenge", "synthesize"]
    title: str = Field(min_length=1)
    content: str = Field(min_length=1)


class ReasoningScaffoldResultV1(_Strict):
    """Unchanged from M1/M2 so stored results stay readable. M4 adds DecisionBriefV1."""

    summary: str = Field(min_length=1)
    stages: list[ReasoningStageV1] = Field(min_length=1)
    caveat: str = Field(min_length=1)


# --- Stage checkpoints (stored in run_stage_outputs.output) -----------------------

STAGE_OUTPUT_SCHEMA_VERSION = "stage-output.v1"


class StageOutputV1(_Strict):
    stage: Stage
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)
    limitations: list[str] = Field(default_factory=list[str], max_length=20)


class StageOutputV2(_Strict):
    """v1 plus the validated structured output of a model-backed stage (M4).

    `data` holds a payload of contract `data_schema` (e.g. decision-frame.v1); it is
    re-validated against that model whenever the checkpoint is loaded.
    """

    stage: Stage
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000)
    limitations: list[str] = Field(default_factory=list[str], max_length=20)
    data_schema: str | None = None
    data: dict[str, Any] | None = None


STAGE_OUTPUT_V2_SCHEMA_VERSION = "stage-output.v2"
StageOutput = StageOutputV1 | StageOutputV2


# --- Model-generated payloads (M4) ---------------------------------------------------
#
# These are sent to the model provider as strict JSON Schemas. OpenAI strict mode lists
# minItems/maxItems as supported but not string length keywords, so string bounds are
# enforced by Pydantic validators (which do not appear in the schema), and every field
# is required (nullable fields are `X | None`, never omitted).


def _bounded(limit: int) -> AfterValidator:
    def check(value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        if len(text) > limit:
            raise ValueError(f"must be at most {limit} characters")
        return text

    return AfterValidator(check)


Short = Annotated[str, _bounded(200)]
Medium = Annotated[str, _bounded(500)]
Long = Annotated[str, _bounded(1500)]
EpistemicLabel = Literal["fact", "inference", "hypothesis", "speculation", "unknown"]
Level = Literal["low", "medium", "high"]


class AssumptionV1(_Strict):
    statement: Medium
    label: EpistemicLabel
    confidence: Level


class DecisionFrameV1(_Strict):
    decision_statement: Medium
    goal: Medium
    time_horizon: Short | None
    options: list[Short] = Field(max_length=8)
    criteria: list[Short] = Field(max_length=8)
    constraints: list[Short] = Field(max_length=10)
    assumptions: list[AssumptionV1] = Field(max_length=10)
    unknowns: list[Medium] = Field(max_length=10)
    research_questions: list[Medium] = Field(max_length=8)
    clarification_needed: bool
    clarifying_question: Medium | None


class ChallengedAssumptionV1(_Strict):
    assumption: Medium
    challenge: Medium
    severity: Level


class RiskV1(_Strict):
    risk: Medium
    severity: Level
    reversibility: Literal["reversible", "partly_reversible", "irreversible"]


class CritiqueV1(_Strict):
    strongest_objection: Long
    challenged_assumptions: list[ChallengedAssumptionV1] = Field(max_length=8)
    alternative_explanations: list[Medium] = Field(max_length=6)
    missing_evidence: list[Medium] = Field(max_length=8)
    risks: list[RiskV1] = Field(max_length=8)


class RecommendationV1(_Strict):
    summary: Medium
    rationale: Long


class CriterionTradeoffV1(_Strict):
    criterion: Short
    tradeoff: Medium


class EvidencePointV1(_Strict):
    point: Medium
    label: EpistemicLabel
    source_ids: list[Short] = Field(max_length=5)


class AlternativeV1(_Strict):
    option: Short
    why_not_now: Medium


class ConfidenceV1(_Strict):
    level: Level
    explanation: Long


class NextActionV1(_Strict):
    action: Medium
    success_signal: Medium
    reversible: bool


class CitationV1(_Strict):
    source_id: Short
    supports: Medium


class MemoryUpdateV1(_Strict):
    kind: Literal["goal", "constraint", "assumption", "decision", "open_question"]
    statement: Medium


class DecisionBriefV1(_Strict):
    """Every section the blueprint (§2.6) requires of a decision brief."""

    decision_question: Medium
    scope: Medium
    recommendation: RecommendationV1
    criteria_and_tradeoffs: list[CriterionTradeoffV1] = Field(min_length=1, max_length=8)
    key_assumptions: list[AssumptionV1] = Field(max_length=10)
    supporting_evidence: list[EvidencePointV1] = Field(max_length=8)
    counterevidence: list[EvidencePointV1] = Field(max_length=8)
    strongest_objection: Long
    alternatives: list[AlternativeV1] = Field(min_length=1, max_length=6)
    confidence: ConfidenceV1
    what_would_change: list[Medium] = Field(min_length=1, max_length=8)
    next_actions: list[NextActionV1] = Field(min_length=1, max_length=6)
    citations: list[CitationV1] = Field(max_length=20)
    proposed_memory_updates: list[MemoryUpdateV1] = Field(max_length=10)
    limitations: list[Medium] = Field(max_length=10)


DECISION_FRAME_SCHEMA_VERSION = "decision-frame.v1"
CRITIQUE_SCHEMA_VERSION = "critique.v1"
DECISION_BRIEF_SCHEMA_VERSION = "decision-brief.v1"

MODEL_OUTPUTS: dict[str, type[BaseModel]] = {
    DECISION_FRAME_SCHEMA_VERSION: DecisionFrameV1,
    CRITIQUE_SCHEMA_VERSION: CritiqueV1,
    DECISION_BRIEF_SCHEMA_VERSION: DecisionBriefV1,
}


# --- Schema export ----------------------------------------------------------------

CONTRACTS: dict[str, type[BaseModel]] = {
    RESULT_SCHEMA_VERSION: ReasoningScaffoldResultV1,
    STAGE_OUTPUT_SCHEMA_VERSION: StageOutputV1,
    STAGE_OUTPUT_V2_SCHEMA_VERSION: StageOutputV2,
    **MODEL_OUTPUTS,
}


def json_schema(version: str) -> dict[str, Any]:
    schema = CONTRACTS[version].model_json_schema()
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"{version}.schema.json",
        **schema,
    }


def render(version: str) -> str:
    return json.dumps(json_schema(version), indent=2, sort_keys=True) + "\n"


def _default_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "contracts"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export or check worker contract JSON Schemas.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    parser.add_argument("--dir", type=Path, default=_default_dir())
    args = parser.parse_args(argv)
    out_dir: Path = args.dir

    stale: list[str] = []
    for version in CONTRACTS:
        path = out_dir / f"{version}.schema.json"
        expected = render(version)
        if args.write:
            path.write_text(expected, encoding="utf-8")
            print(f"wrote {path}")
        elif not path.exists() or path.read_text(encoding="utf-8") != expected:
            stale.append(str(path))
    if stale:
        print(
            "Stale or missing contract schemas (run --write and commit):\n  " + "\n  ".join(stale),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
