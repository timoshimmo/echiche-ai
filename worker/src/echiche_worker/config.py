"""Worker configuration, validated from the environment.

Error messages name variables and rules, never values, so they are safe to log.
Pydantic arrives in M3 (ADR-001 D3); this small stdlib validator avoids adding a
dependency before there is a payload contract to model.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit

_POSTGRES_SCHEMES = frozenset({"postgres", "postgresql"})


class ConfigError(Exception):
    """Raised when the environment does not describe a valid worker configuration."""

    code = "CONFIG_INVALID"

    def __init__(self, issues: list[str]) -> None:
        self.issues = issues
        super().__init__("Invalid worker configuration: " + "; ".join(issues))


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    database_url: str
    poll_interval_seconds: float
    worker_id: str

    def __repr__(self) -> str:  # never print the connection string
        return (
            f"WorkerConfig(database_url='***', poll_interval_seconds={self.poll_interval_seconds}, "
            f"worker_id={self.worker_id!r})"
        )


def _blank_to_none(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return value.strip()


def parse_worker_config(env: Mapping[str, str]) -> WorkerConfig:
    issues: list[str] = []

    database_url = _blank_to_none(env.get("DATABASE_URL"))
    if database_url is None:
        issues.append("DATABASE_URL is required (the worker has no in-memory mode)")
    else:
        parts = urlsplit(database_url)
        if parts.scheme not in _POSTGRES_SCHEMES or not parts.hostname:
            issues.append("DATABASE_URL must be a postgres:// or postgresql:// URL with a host")

    poll_raw = _blank_to_none(env.get("WORKER_POLL_INTERVAL_SECONDS")) or "2"
    poll_interval = 0.0
    try:
        poll_interval = float(poll_raw)
    except ValueError:
        issues.append("WORKER_POLL_INTERVAL_SECONDS must be a number")
    else:
        if not math.isfinite(poll_interval) or not 0.1 <= poll_interval <= 60:
            issues.append("WORKER_POLL_INTERVAL_SECONDS must be between 0.1 and 60")

    worker_id = _blank_to_none(env.get("WORKER_ID")) or "worker-local"
    if len(worker_id) > 64 or not all(ch.isalnum() or ch in "-_." for ch in worker_id):
        issues.append("WORKER_ID must be at most 64 characters of letters, digits, '-', '_' or '.'")

    if issues or database_url is None:
        raise ConfigError(issues)
    return WorkerConfig(database_url=database_url, poll_interval_seconds=poll_interval, worker_id=worker_id)
