# Echiche worker (Python)

Owns run execution ([ADR-001](../docs/decisions/001-language-and-service-boundary.md), [ADR-006](../docs/decisions/006-durable-run-orchestration.md)). It claims queued runs from Postgres, executes the five stages with checkpoints, leases, retries, budgets and cancellation, and writes the result for the user's review. Deployed as a Render Background Worker ([ADR-005](../docs/decisions/005-hosting.md)).

The reasoning provider is still the deterministic, non-LLM scaffold. M4 adds a real provider behind `ReasoningProvider`.

## Setup

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12.

```bash
cd worker
uv sync --locked
uv run ruff check . && uv run ruff format --check . && uv run pyright
uv run pytest                                   # unit tests (no database)
uv run python -m echiche_worker.contracts --check

# Integration tests: a disposable DB prepared by `npm run test:db:prepare` at the repo root
TEST_ADMIN_DATABASE_URL=postgresql://postgres@localhost:5432/echiche_test \
WORKER_TEST_DATABASE_URL=postgresql://echiche_worker:test-only-password@localhost:5432/echiche_test \
  uv run pytest -m integration

# Run it
DATABASE_URL=postgresql://echiche_worker:...@.../postgres uv run echiche-worker          # until SIGTERM
DATABASE_URL=... uv run echiche-worker --once                                            # drain queue, exit
DATABASE_URL=... uv run echiche-worker --check-config                                    # validate env (exit 0/2)
```

Docker (same image Render builds): `docker build -t echiche-worker . && docker run --env-file ../.env.worker echiche-worker`.

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Connect **as `echiche_worker`** (migration 0003; password per the runbook). Never `postgres`. Transaction-mode poolers are supported. |
| `WORKER_POLL_INTERVAL_SECONDS` | no | `2` | 0.1–60; idle wait between claims |
| `WORKER_LEASE_SECONDS` | no | `60` | 10–600; a crashed worker's run is reclaimable after this |
| `WORKER_STAGE_TIMEOUT_SECONDS` | no | `120` | 1–1800; also capped by the run's remaining time budget |
| `WORKER_ID` | no | `worker-<hostname>` | ≤64 chars of `[A-Za-z0-9._-]`; unique per instance |

## Layout

| Module | Role |
|---|---|
| `contracts.py` | Pydantic payloads, the source of truth for `contracts/*.schema.json` |
| `provider.py` | `ReasoningProvider` protocol, error classes and the deterministic provider |
| `retry.py` | Bounded retry with full-jitter backoff (transient errors only) |
| `store.py` | Lease-guarded Postgres reads and writes; transactional checkpoints |
| `executor.py` | One run: resume, cancel and budget checks, stage calls, failure policy |
| `__main__.py` | Claim loop, heartbeats, reconnect with backoff, SIGTERM handling |

## Boundary rules

- **Isolation:** never import or call the web app. Read and write only what migration 0004 grants `echiche_worker`; the transition trigger rejects anything else.
- **Secrets:** model and research provider keys live only in the worker's environment.
- **Logging:** use `echiche_worker.log.log` (fields shared with the web app). Never log prompts, user content, model output or raw driver error messages.
