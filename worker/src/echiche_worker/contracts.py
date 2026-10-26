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
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

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


# --- Schema export ----------------------------------------------------------------

CONTRACTS: dict[str, type[BaseModel]] = {
    RESULT_SCHEMA_VERSION: ReasoningScaffoldResultV1,
    STAGE_OUTPUT_SCHEMA_VERSION: StageOutputV1,
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
