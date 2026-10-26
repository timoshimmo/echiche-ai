"""Builds the final run result from stage checkpoints (pure, no I/O)."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from echiche_worker.contracts import ReasoningScaffoldResultV1, ReasoningStageV1, Stage, StageOutputV1

CAVEAT = (
    "Starter mode: this output is a deterministic scaffold, not model-generated analysis or verified research. "
    "Add evidence and connect an evaluated reasoning provider before relying on Echiche for consequential decisions."
)


class MissingStageError(Exception):
    code = "RESULT_INVALID"


def compose_result(prompt: str, outputs: Mapping[Stage, StageOutputV1]) -> ReasoningScaffoldResultV1:
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
