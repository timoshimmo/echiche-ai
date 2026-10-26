"""Builds the final run result from stage checkpoints (pure, no I/O)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel

from echiche_worker.contracts import (
    DECISION_BRIEF_SCHEMA_VERSION,
    DECISION_FRAME_SCHEMA_VERSION,
    RESULT_SCHEMA_VERSION,
    DecisionBriefV1,
    DecisionFrameV1,
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
    if getattr(planning, "data_schema", None) != DECISION_FRAME_SCHEMA_VERSION or data is None:
        return brief
    frame = DecisionFrameV1.model_validate(data)
    if not frame.clarification_needed or not frame.clarifying_question or len(brief.limitations) >= 10:
        return brief
    note = f"Open question from framing: {frame.clarifying_question}"
    if len(note) > 500:
        note = note[:497] + "..."
    return brief.model_copy(update={"limitations": [*brief.limitations, note]})


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
        return DECISION_BRIEF_SCHEMA_VERSION, _with_clarification(brief, outputs.get("planning"))
    return RESULT_SCHEMA_VERSION, compose_result(prompt, outputs)
