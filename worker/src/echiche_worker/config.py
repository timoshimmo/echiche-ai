"""Worker configuration, validated from the environment.

Error messages name variables and rules, never values, so they are safe to log.
"""

from __future__ import annotations

import math
import re
import socket
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
    lease_seconds: int
    stage_timeout_seconds: int

    def __repr__(self) -> str:  # never print the connection string
        return (
            f"WorkerConfig(database_url='***', poll_interval_seconds={self.poll_interval_seconds}, "
            f"worker_id={self.worker_id!r}, lease_seconds={self.lease_seconds}, "
            f"stage_timeout_seconds={self.stage_timeout_seconds})"
        )


def _blank_to_none(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    return value.strip()


def _number(env: Mapping[str, str], name: str, default: str, low: float, high: float, issues: list[str]) -> float:
    raw = _blank_to_none(env.get(name)) or default
    try:
        value = float(raw)
    except ValueError:
        issues.append(f"{name} must be a number")
        return float(default)
    if not math.isfinite(value) or not low <= value <= high:
        issues.append(f"{name} must be between {low:g} and {high:g}")
    return value


def default_worker_id() -> str:
    """Unique per container without configuration: Render (and Docker) give each instance its own hostname."""
    host = re.sub(r"[^A-Za-z0-9._-]", "-", socket.gethostname()) or "local"
    return f"worker-{host}"[:64]


def parse_worker_config(env: Mapping[str, str]) -> WorkerConfig:
    issues: list[str] = []

    database_url = _blank_to_none(env.get("DATABASE_URL"))
    if database_url is None:
        issues.append("DATABASE_URL is required (the worker has no in-memory mode)")
    else:
        parts = urlsplit(database_url)
        if parts.scheme not in _POSTGRES_SCHEMES or not parts.hostname:
            issues.append("DATABASE_URL must be a postgres:// or postgresql:// URL with a host")

    poll_interval = _number(env, "WORKER_POLL_INTERVAL_SECONDS", "2", 0.1, 60, issues)
    lease = _number(env, "WORKER_LEASE_SECONDS", "60", 10, 600, issues)
    stage_timeout = _number(env, "WORKER_STAGE_TIMEOUT_SECONDS", "120", 1, 1800, issues)

    worker_id = _blank_to_none(env.get("WORKER_ID")) or default_worker_id()
    if len(worker_id) > 64 or not all(ch.isalnum() or ch in "-_." for ch in worker_id):
        issues.append("WORKER_ID must be at most 64 characters of letters, digits, '-', '_' or '.'")

    if issues or database_url is None:
        raise ConfigError(issues)
    return WorkerConfig(
        database_url=database_url,
        poll_interval_seconds=poll_interval,
        worker_id=worker_id,
        lease_seconds=int(lease),
        stage_timeout_seconds=int(stage_timeout),
    )
