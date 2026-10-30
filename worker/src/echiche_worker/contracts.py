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


class MemoryConflictV1(_Strict):
    ref: str = Field(pattern=r"^(M|D)[0-9]{1,3}$")
    conflict: Medium


class DecisionFrameV2(_Strict):
    """v1 plus `memory_conflicts` (M6): remembered items the new question or context contradicts
    or may have made outdated, by the ref the application supplied."""

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
    memory_conflicts: list[MemoryConflictV1] = Field(max_length=8)


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


# --- Research and verification (M5, ADR-008) ------------------------------------------
#
# IDs are assigned by the application, never by the model: sources are S1..Sn and passages
# S<n>.p<m> in the order they were read; claims are C1..Cn as extracted. The model may only
# refer to IDs it was given; every reference is checked deterministically.

SourceId = Annotated[str, Field(pattern=r"^S[0-9]{1,3}$")]
PassageId = Annotated[str, Field(pattern=r"^S[0-9]{1,3}\.p[0-9]{1,2}$")]
ClaimId = Annotated[str, Field(pattern=r"^C[0-9]{1,3}$")]
Relation = Literal["supports", "contradicts", "context"]


class ResearchQueryV1(_Strict):
    query: Short
    research_question: Medium
    rationale: Medium


class ResearchPlanV1(_Strict):
    """Model output: bounded search queries. The application enforces the actual limit."""

    queries: list[ResearchQueryV1] = Field(max_length=8)
    skipped_questions: list[Medium] = Field(max_length=8)


class ClaimEvidenceV1(_Strict):
    passage_id: PassageId
    relation: Relation
    quote: Medium  # must be an exact (whitespace-normalised) substring of the passage


class ExtractedClaimV1(_Strict):
    claim_id: ClaimId
    text: Medium
    label: EpistemicLabel
    evidence: list[ClaimEvidenceV1] = Field(min_length=1, max_length=3)


class ClaimSetV1(_Strict):
    """Model output: decision-relevant claims, each tied to exact quotes from supplied passages."""

    claims: list[ExtractedClaimV1] = Field(max_length=15)
    gaps: list[Medium] = Field(max_length=8)


class ClaimJudgmentV1(_Strict):
    claim_id: ClaimId
    passage_id: PassageId
    verdict: Literal["supported", "partially_supported", "not_supported"]
    note: Medium


class ClaimVerificationV1(_Strict):
    """Model output from the independent verifier: one judgment per (claim, passage) pair."""

    judgments: list[ClaimJudgmentV1] = Field(max_length=45)


# Application-built payloads (checkpoint data; never produced by a model).


class PassageV1(_Strict):
    passage_id: str = Field(pattern=r"^S[0-9]{1,3}\.p[0-9]{1,2}$")
    text: str = Field(min_length=1, max_length=600)


class SourceRecordV1(_Strict):
    source_id: str = Field(pattern=r"^S[0-9]{1,3}$")
    url: str = Field(pattern=r"^https://", max_length=2048)
    domain: str = Field(min_length=1, max_length=253)
    title: str = Field(min_length=1, max_length=300)
    publisher: str | None = Field(max_length=200)
    published_at: str | None  # ISO 8601 date or datetime as declared by the page; None if unknown
    retrieved_at: str  # ISO 8601 UTC
    content_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    search_query: str = Field(max_length=400)
    passages: list[PassageV1] = Field(min_length=1, max_length=3)


class SkippedSourceV1(_Strict):
    domain: str = Field(max_length=253)
    status: Literal[
        "blocked_robots",
        "blocked_publisher",
        "blocked_address",
        "unsupported_url",
        "unsupported_type",
        "too_large",
        "http_error",
        "timeout",
        "fetch_error",
        "no_text",
        "duplicate",
        "irrelevant",
        "not_attempted",
    ]


class SearchSummaryV1(_Strict):
    query: str = Field(max_length=400)
    status: Literal["ok", "no_results", "failed"]
    result_count: int = Field(ge=0)


class EvidenceSetV1(_Strict):
    provider: str
    searches: list[SearchSummaryV1] = Field(max_length=8)
    sources: list[SourceRecordV1] = Field(max_length=12)
    skipped: list[SkippedSourceV1] = Field(max_length=100)
    limitations: list[str] = Field(max_length=10)


class VerifiedEvidenceV1(_Strict):
    source_id: str
    passage_id: str
    relation: Relation
    quote: str
    verdict: Literal["supported", "partially_supported", "not_supported", "quote_not_found"]
    note: str


class VerifiedClaimV1(_Strict):
    claim_id: str
    text: str
    label: EpistemicLabel
    status: Literal["verified", "partial", "unsupported", "invalid"]
    freshness: Literal["fresh", "stale", "unknown"]
    evidence: list[VerifiedEvidenceV1]


class VerificationReportV1(_Strict):
    claims: list[VerifiedClaimV1] = Field(max_length=15)
    contradictions: list[str] = Field(max_length=15)  # claim IDs with both support and contradiction
    unverifiable: list[str] = Field(max_length=20)
    limitations: list[str] = Field(max_length=10)


DECISION_FRAME_SCHEMA_VERSION = "decision-frame.v1"
DECISION_FRAME_V2_SCHEMA_VERSION = "decision-frame.v2"
CRITIQUE_SCHEMA_VERSION = "critique.v1"
DECISION_BRIEF_SCHEMA_VERSION = "decision-brief.v1"
RESEARCH_PLAN_SCHEMA_VERSION = "research-plan.v1"
CLAIM_SET_SCHEMA_VERSION = "claim-set.v1"
CLAIM_VERIFICATION_SCHEMA_VERSION = "claim-verification.v1"
EVIDENCE_SET_SCHEMA_VERSION = "evidence-set.v1"
VERIFICATION_REPORT_SCHEMA_VERSION = "verification-report.v1"

# --- Attachment reading (ADR-012) -----------------------------------------------------

ATTACHMENT_READING_SCHEMA_VERSION = "attachment-reading.v1"


class AttachmentReadingV1(_Strict):
    """What the model could read from an image the user attached: its text and a factual description."""

    readable: bool
    content: str = Field(max_length=8000)


MODEL_OUTPUTS: dict[str, type[BaseModel]] = {
    DECISION_FRAME_SCHEMA_VERSION: DecisionFrameV1,
    DECISION_FRAME_V2_SCHEMA_VERSION: DecisionFrameV2,
    CRITIQUE_SCHEMA_VERSION: CritiqueV1,
    DECISION_BRIEF_SCHEMA_VERSION: DecisionBriefV1,
    RESEARCH_PLAN_SCHEMA_VERSION: ResearchPlanV1,
    CLAIM_SET_SCHEMA_VERSION: ClaimSetV1,
    CLAIM_VERIFICATION_SCHEMA_VERSION: ClaimVerificationV1,
    ATTACHMENT_READING_SCHEMA_VERSION: AttachmentReadingV1,
}

# Checkpoint payloads the application builds itself (stage-output.v2 `data`).
STAGE_DATA: dict[str, type[BaseModel]] = {
    **MODEL_OUTPUTS,
    EVIDENCE_SET_SCHEMA_VERSION: EvidenceSetV1,
    VERIFICATION_REPORT_SCHEMA_VERSION: VerificationReportV1,
}


# --- Schema export ----------------------------------------------------------------

CONTRACTS: dict[str, type[BaseModel]] = {
    RESULT_SCHEMA_VERSION: ReasoningScaffoldResultV1,
    STAGE_OUTPUT_SCHEMA_VERSION: StageOutputV1,
    STAGE_OUTPUT_V2_SCHEMA_VERSION: StageOutputV2,
    **STAGE_DATA,
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
