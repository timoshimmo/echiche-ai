"""Structured JSON logging shared in shape with the web app (ADR-001 D7).

One JSON object per line. Shared field names: run_id, project_id, stage, event, error_code.
Never pass prompts, user content, model output or raw driver error messages as fields.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from typing import Literal, TextIO

Level = Literal["info", "warn", "error"]
FieldValue = str | int | float | bool | None | list[str]


def log(level: Level, event: str, stream: TextIO | None = None, /, **fields: FieldValue) -> None:
    record: dict[str, FieldValue] = {
        "ts": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "level": level,
        "service": "worker",
        "event": event,
        **fields,
    }
    target = stream if stream is not None else (sys.stderr if level == "error" else sys.stdout)
    target.write(json.dumps(record, separators=(",", ":")) + "\n")
    target.flush()
