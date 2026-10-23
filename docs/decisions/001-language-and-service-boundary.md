# ADR-001: Language and service boundary — TypeScript web app + Python AI worker

- Status: Accepted (boundary) · Sub-decisions D1–D8 proposed with defaults, pending confirmation
- Date: 2026-10-23
- Decision owner: Tokmang (engineer / product owner)
- Related PRD requirement(s): Blueprint §4.1–4.4, §6.3, §7; RUN-01/02/03, AUTH-02, OBS-01, TEST-01
- Note: the blueprint's own list reserves "ADR-001" for the model provider. Renumber that one to ADR-011 when written.

## Context
The starter is a single Next.js/TypeScript app (~400 lines) whose thought runs execute synchronously inside an API request. The blueprint requires asynchronous, checkpointed, budgeted runs with model and research adapters, a critic/verifier and memory proposals. The engineer is strongest in Python. Prompt 00 audit compared:

- A — TypeScript for UI, API and worker
- B — TypeScript for UI and API; Python for AI orchestration / background worker
- C — move most of the backend to Python

## Decision
**Option B.** Next.js/TypeScript owns the UI, authentication, authorization and all user-facing CRUD. A Python worker owns run execution: the state machine, budgets, model/research adapters, critic/verifier, synthesis and memory *proposals*. The two communicate **only through PostgreSQL rows and versioned JSON contracts**. There are no direct HTTP calls between them in v1.

## Rationale
- The AI-heavy, fastest-changing part of the system is written in the language the engineer is most productive in.
- The split falls on a natural seam: user-facing request/response work vs. long-running jobs. A long-running worker host is needed under any option, so B adds a language, not a whole new tier.
- Python has stronger options for later P1 work (document parsing, evaluation statistics).
- Accepted costs, recorded honestly: two toolchains, two test suites, two dependency-audit streams, a cross-language contract that must be kept in sync, and a required end-to-end integration test.

## Ownership boundary

| Concern | Owner | Notes |
|---|---|---|
| UI, sessions, authn/authz | TS | The worker never receives user credentials. |
| API request schemas (Zod) | TS | Input validation at the HTTP edge. |
| Projects CRUD, run creation (`queued` + idempotency key), cancel request, memory confirm/edit/delete, export | TS | TS writes user intent. |
| Run claiming, state transitions after claim, run_events, checkpoints | Python | Worker writes execution facts. |
| Model / research adapters, prompts in `prompts/runtime/`, budgets, critic/verifier | Python | Only the worker calls paid providers. |
| Decision brief, claims, sources, memory *proposals*, usage_events | Python | Validated with Pydantic before write. |
| Schema migrations | Neither ORM — plain SQL in `supabase/migrations/` | Single source of schema truth. |

Rule: **the side that writes a payload owns its schema.** No business rule is implemented on both sides. The current TypeScript `run-service.ts`/`reasoning.ts` are deleted once the Python worker reaches parity (M3); the deterministic engine moves to Python as a test-double provider.

## Sub-decisions (proposed defaults — confirm or change)
- **D1 Contracts:** Pydantic v2 models are the source for worker-owned payloads (`DecisionBriefV1`, run result, event payloads). They are exported to committed JSON Schema in `contracts/`; TS derives types from those files. CI fails if the generated files are stale. Each payload stores a `schema_version`.
- **D2 Worker shape:** a plain Python process that claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`, a lease and a heartbeat. No FastAPI until an HTTP need exists; a minimal health check is enough.
- **D3 Python toolchain:** Python 3.12, `uv`, `ruff`, `pyright` (strict) or `mypy --strict`, `pytest`, `pydantic`, `psycopg[binary]` 3. No SQLAlchemy/Alembic (migrations stay SQL).
- **D4 Layout:** the Next app stays at the repo root; add `worker/` (Python package) and `contracts/`. No monorepo restructure.
- **D5 Database roles:** separate least-privilege roles `echiche_web` and `echiche_worker`, each granted only the tables and columns it writes. Neither is a superuser or service role.
- **D6 Cancellation:** TS sets `cancel_requested_at`; the worker checks between stages and transitions to `cancelled`.
- **D7 Observability:** both sides emit JSON logs with shared field names (`run_id`, `project_id`, `stage`, `event`, `error_code`) and the same redaction rules. Never log prompts or user content by default.
- **D8 CI:** separate `web` and `worker` jobs plus one integration job. A Postgres service container runs the TS API, which enqueues a run; the Python worker completes it, and TS reads the result back.

## Consequences
- Positive: AI orchestration in the engineer's strongest language; a clean job seam; Python evaluation tooling sits naturally beside the worker.
- Negative: contract drift risk; two runtimes to patch; a feature that spans intent and execution touches both languages.
- Security/privacy: provider keys live only in the worker environment; the worker has no user-auth surface; DB roles separate the two blast radii.
- Reliability/operations: two deployables (web app + worker) and a worker host that supports long-running processes.
- Cost: no new paid service is introduced by this ADR; hosting is decided separately.
- Migration/rollback: before M3 nothing user-visible depends on Python, so reverting to Option A is cheap. After M3, reverting means re-implementing the worker in TS against the same tables.

## Revisit trigger
- More than two production or CI incidents caused by TS↔Python contract drift within a quarter; or
- A business rule is found to need logic on both sides and cannot be assigned to one owner; or
- Worker hosting costs or constraints make a second runtime materially more expensive than the estimate.
