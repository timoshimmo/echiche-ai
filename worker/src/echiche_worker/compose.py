"""Builds the final run result from stage checkpoints (pure, no I/O)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel

from echiche_worker.contracts import (
    DECISION_BRIEF_SCHEMA_VERSION,
    DECISION_FRAME_SCHEMA_VERSION,
    DECISION_FRAME_V2_SCHEMA_VERSION,
    RESULT_SCHEMA_VERSION,
    DecisionBriefV1,
    DecisionFrameV1,
    DecisionFrameV2,
    ReasoningScaffoldResultV1,
    ReasoningStageV1,
    Stage,
    StageOutput,
)

CAVEAT = (
    "Starter mode: this output is a deterministic scaffold, not model-generated analysis or verified research. "
    "Add evidence and connect an evaluated reasoning provider before relying on Echiche for consequential decisions."
)


class MissingStageError(Exception):
    code = "RESULT_INVALID"


def compose_result(prompt: str, outputs: Mapping[Stage, StageOutput]) -> ReasoningScaffoldResultV1:
    """Maps planning/critiquing/synthesizing onto the reasoning-scaffold.v1 shape.

    Raises MissingStageError if a required checkpoint is absent, and pydantic's
    ValidationError if the composed result breaks the contract.
    """
    mapping: tuple[tuple[Stage, Literal["frame", "challenge", "synthesize"]], ...] = (
        ("planning", "frame"),
        ("critiquing", "challenge"),
        ("synthesizing", "synthesize"),
    )
    stages: list[ReasoningStageV1] = []
    for source, target in mapping:
        output = outputs.get(source)
        if output is None:
            raise MissingStageError(f"missing checkpoint for {source}")
        stages.append(ReasoningStageV1(stage=target, title=output.title, content=output.content))

    question = " ".join(prompt.split())
    if len(question) > 360:
        question = f"{question[:357]}..."
    limitations = sorted({item for output in outputs.values() for item in output.limitations})
    caveat = CAVEAT if not limitations else f"{CAVEAT} Limitations: {' '.join(limitations)}"
    return ReasoningScaffoldResultV1(
        summary=f"A first-pass thinking structure for: “{question}”", stages=stages, caveat=caveat
    )


def _with_clarification(brief: DecisionBriefV1, planning: StageOutput | None) -> DecisionBriefV1:
    """Surfaces the framing stage's clarifying question (if the model asked one) as a limitation,
    so the user sees it even when the synthesis did not repeat it."""
    data = getattr(planning, "data", None)
    schema = getattr(planning, "data_schema", None)
    if data is None or schema not in (DECISION_FRAME_SCHEMA_VERSION, DECISION_FRAME_V2_SCHEMA_VERSION):
        return brief
    frame: DecisionFrameV1 | DecisionFrameV2 = (
        DecisionFrameV2.model_validate(data)
        if schema == DECISION_FRAME_V2_SCHEMA_VERSION
        else DecisionFrameV1.model_validate(data)
    )
    notes: list[str] = []
    if frame.clarification_needed and frame.clarifying_question:
        notes.append(f"Open question from framing: {frame.clarifying_question}")
    if isinstance(frame, DecisionFrameV2):
        # Contradictions with what the project remembers are surfaced, never silently resolved.
        notes.extend(f"Remembered item {c.ref} may be outdated: {c.conflict}" for c in frame.memory_conflicts)
    merged = list(brief.limitations)
    for note in notes:
        text = note if len(note) <= 500 else note[:497] + "..."
        if text not in merged and len(merged) < 10:
            merged.append(text)
    return brief if merged == list(brief.limitations) else brief.model_copy(update={"limitations": merged})


def _with_research_limits(brief: DecisionBriefV1, outputs: Mapping[Stage, StageOutput]) -> DecisionBriefV1:
    """Carries the research and verification stages' limitations into the brief verbatim
    (deterministic, application-written), so evidence gaps can never be dropped by the model."""
    notes = [n for s in ("researching", "verifying") for n in getattr(outputs.get(s), "limitations", [])]
    merged = list(brief.limitations)
    for note in notes:
        text = note if len(note) <= 500 else note[:497] + "..."
        if text not in merged and len(merged) < 10:
            merged.append(text)
    return brief if merged == list(brief.limitations) else brief.model_copy(update={"limitations": merged})


def compose_final(prompt: str, outputs: Mapping[Stage, StageOutput]) -> tuple[str, BaseModel]:
    """Returns (result_schema_version, result).

    A model-backed synthesis checkpoint carries a decision-brief.v1 payload, which is
    re-validated and becomes the result; otherwise the demo scaffold is composed.
    """
    synthesis = outputs.get("synthesizing")
    data_schema = getattr(synthesis, "data_schema", None)
    data = getattr(synthesis, "data", None)
    if data_schema == DECISION_BRIEF_SCHEMA_VERSION and data is not None:
        missing = [s for s in ("planning", "critiquing", "verifying") if s not in outputs]
        if missing:
            raise MissingStageError(f"missing checkpoint for {missing[0]}")
        brief = DecisionBriefV1.model_validate(data)
        brief = _with_clarification(brief, outputs.get("planning"))
        return DECISION_BRIEF_SCHEMA_VERSION, _with_research_limits(brief, outputs)
    return RESULT_SCHEMA_VERSION, compose_result(prompt, outputs)
