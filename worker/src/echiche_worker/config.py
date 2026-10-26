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
PROVIDERS = ("deterministic", "openai")
OPENAI_RESIDENCIES = ("global", "eu")
DEFAULT_OPENAI_MODEL = "gpt-6.1-sol"
# Same set the pinned SDK accepts; not every model supports every value (OpenAI reasoning guide).
OPENAI_REASONING_EFFORTS = ("none", "minimal", "low", "medium", "high", "xhigh", "max")


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
    reasoning_provider: str = "deterministic"
    openai_api_key: str | None = None
    openai_model: str = DEFAULT_OPENAI_MODEL
    openai_reasoning_effort: str | None = None
    openai_data_residency: str = "global"
    openai_max_output_tokens: int = 4000

    def __repr__(self) -> str:  # never print the connection string or API key
        return (
            f"WorkerConfig(database_url='***', poll_interval_seconds={self.poll_interval_seconds}, "
            f"worker_id={self.worker_id!r}, lease_seconds={self.lease_seconds}, "
            f"stage_timeout_seconds={self.stage_timeout_seconds}, reasoning_provider={self.reasoning_provider!r}, "
            f"openai_api_key={'***' if self.openai_api_key else None}, openai_model={self.openai_model!r}, "
            f"openai_reasoning_effort={self.openai_reasoning_effort!r}, "
            f"openai_data_residency={self.openai_data_residency!r}, "
            f"openai_max_output_tokens={self.openai_max_output_tokens})"
        )

    __str__ = __repr__


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

    provider = (_blank_to_none(env.get("REASONING_PROVIDER")) or "deterministic").lower()
    if provider not in PROVIDERS:
        issues.append(f"REASONING_PROVIDER must be one of {', '.join(PROVIDERS)}")
    api_key = _blank_to_none(env.get("OPENAI_API_KEY"))
    model = _blank_to_none(env.get("OPENAI_MODEL")) or DEFAULT_OPENAI_MODEL
    effort = _blank_to_none(env.get("OPENAI_REASONING_EFFORT"))
    residency = (_blank_to_none(env.get("OPENAI_DATA_RESIDENCY")) or "global").lower()
    max_output = _number(env, "OPENAI_MAX_OUTPUT_TOKENS", "4000", 256, 32000, issues)
    if provider == "openai":
        if api_key is None:
            issues.append("OPENAI_API_KEY is required when REASONING_PROVIDER=openai")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", model):
            issues.append("OPENAI_MODEL must be a model ID")
        if effort is not None and effort not in OPENAI_REASONING_EFFORTS:
            issues.append(f"OPENAI_REASONING_EFFORT must be one of {', '.join(OPENAI_REASONING_EFFORTS)}")
        if residency not in OPENAI_RESIDENCIES:
            issues.append(f"OPENAI_DATA_RESIDENCY must be one of {', '.join(OPENAI_RESIDENCIES)}")
        if not float(max_output).is_integer():
            issues.append("OPENAI_MAX_OUTPUT_TOKENS must be a whole number")

    if issues or database_url is None:
        raise ConfigError(issues)
    return WorkerConfig(
        database_url=database_url,
        poll_interval_seconds=poll_interval,
        worker_id=worker_id,
        lease_seconds=int(lease),
        stage_timeout_seconds=int(stage_timeout),
        reasoning_provider=provider,
        openai_api_key=api_key,
        openai_model=model,
        openai_reasoning_effort=effort,
        openai_data_residency=residency,
        openai_max_output_tokens=int(max_output),
    )
