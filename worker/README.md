# Echiche worker (Python)

Owns run execution per [ADR-001](../docs/decisions/001-language-and-service-boundary.md). **M1 status:** skeleton only. It validates configuration and emits structured logs, and there is no job loop yet. That arrives in M3.

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12.

```bash
cd worker
uv sync --locked            # creates .venv from uv.lock
uv run ruff check .
uv run ruff format --check .
uv run pyright
uv run pytest
DATABASE_URL=postgresql://... uv run echiche-worker   # exits 0 if config is valid, 2 if not
```

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | postgres:// or postgresql:// URL, connecting **as `echiche_worker`** (created by migration 0003; password set per the runbook). Never `postgres`. |
| `WORKER_POLL_INTERVAL_SECONDS` | no | `2` | 0.1–60 |
| `WORKER_ID` | no | `worker-local` | ≤64 chars of `[A-Za-z0-9._-]`; used in logs and job leases |

## Boundary rules

- Never import or call the web app. Read and write only the tables ADR-001 assigns to the worker.
- Model and research provider keys live only in the worker's environment.
- Log with `echiche_worker.log.log`. Never log prompts, user content, model output or raw driver error messages.
