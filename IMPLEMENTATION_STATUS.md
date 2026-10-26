# Implementation and verification status

_Last updated: 2026-10-26 (M3, "Durable run orchestration")_

"Verified" means the check was actually run, with the stated result, in the environment noted. Code presence alone is not verification.

## Verified locally (Linux, Node 22.22.0, PostgreSQL 16.15, Supabase CLI 2.120.0, Python 3.12.3, uv 0.11)

From a **clean clone** against a **fresh database**:

| Check | Result |
|---|---|
| `npm ci` · typecheck · lint | ✅ · 0 errors · 0 problems |
| `npm test` (web unit: routes incl. async runs/actions, config, cross-language contract) | ✅ 39 tests |
| `npm run build` (no env); client-bundle scan; `npm audit --omit=dev` | ✅ · none found · 0 vulnerabilities |
| `npm run test:db:prepare` from empty (0001–0004 via Supabase CLI), then re-run | ✅ · ✅ no-op |
| `npm run test:integration`: repository + RLS as `echiche_web`, plus **cross-language E2E** (TS queues → real Python worker → TS reads and accepts) | ✅ 33 tests |
| Worker: `uv sync --locked`, ruff, ruff format, pyright strict (incl. tests), `contracts --check` | ✅ |
| Worker unit tests | ✅ 36 tests |
| Worker integration (as `echiche_worker`) | ✅ 28 tests |
| Same web and worker integration suites on a **fresh cluster with a Supabase-like admin** (non-superuser, CREATEROLE, BYPASSRLS) | ✅ 33 + 28 |

What the 28 worker integration tests cover:
- crash mid-run then resume from checkpoint with no duplicate writes;
- a valid lease blocks takeover, and an expired lease allows it;
- 6 workers racing for one run, and 8 workers draining 25 runs: each run executes exactly once;
- a worker that lost its lease cannot write;
- cancellation between stages, and direct cancellation of queued runs;
- step and time budget pauses, then an explicit resume continues from the checkpoint;
- transient retries within a claim; timeouts requeue with backoff, then fail at `max_attempts`;
- invalid output fails without retry; wrong-stage output; unexpected exceptions;
- the max-attempts guard; graceful shutdown doesn't consume an attempt;
- illegal transitions rejected for both roles (backwards moves, end-user shortcuts, budget decreases, clearing a cancel request);
- heartbeats and the stale-run view; `--once` CLI drain.

**Bug found and fixed by these tests:** two workers could claim the same queued run. A claimed run stays `queued` until its first stage starts, and `FOR UPDATE` rechecks the predicate against the committed row. The claim query now excludes any run with a live lease. Removing that guard makes the concurrency tests fail (mutation check).

**Production smoke test** (`next start` in production mode, a continuously running worker process, local HTTPS stand-in for Supabase Auth, real session cookies):
- 202 with `Location`; Idempotency-Key replay returns 200.
- The worker ran 3 stages and paused at the 3-step budget. Another user's resume returned 404.
- The owner's resume raised the caps and continued from the checkpoint to "awaiting review". Accept then gave `completed`, and cancelling the finished run returned 409.
- Events were sequenced 1–12.
- On SIGTERM the worker exited cleanly and removed its heartbeat.

**Worker image:** the Dockerfile's build steps were replayed outside Docker (`uv sync --locked --no-dev`, then the entry point). The production environment has no dev tools, and config exit codes are 0/2. The Docker build itself runs in CI.

## Not yet verified (no Docker or hosted accounts in the build environment)

- **GitHub Actions jobs:** `supabase-stack` (real local Supabase), the worker Docker build/run, and the overall first CI run.
- **Render deployment:** the Blueprint, the health check, and the Supabase pooler accepting the `echiche_web.<ref>` / `echiche_worker.<ref>` custom roles. See [render-deploy.md](docs/runbooks/render-deploy.md).
- **The magic-link email round trip** (manual, local stack).

## Implemented

**M3**
- **Migration 0004:**
  - blueprint run states with a per-role transition trigger;
  - leases, attempts, backoff (`available_at`), budgets and usage, and idempotency keys;
  - `run_stage_outputs` checkpoints, `worker_heartbeats`, and the `ops_run_health` view;
  - least-privilege grants: end users can't write results, events or execution fields; the worker can't edit prompts, owners, budgets or `completed_at`.
- **Python worker:**
  - claim loop (`SKIP LOCKED` + leases) with a lease-keeper thread;
  - transactional checkpoints, and lease-guarded writes;
  - bounded jittered retries, stage timeouts, the failure policy with stable codes, budgets, cancellation;
  - SIGTERM drain, reconnect with backoff, heartbeats, and `--once` / `--check-config`.
- **Contracts:** Pydantic models are the source; JSON Schemas are committed; shared fixtures; the TypeScript mirror is checked against them; CI fails on stale schemas.
- **Web:**
  - `POST /runs` returns 202 plus Idempotency-Key handling; budgets come from config;
  - cancel / accept / resume endpoints (idempotent, owner-scoped, CSRF-checked);
  - safe error-code messages; the UI polls with stage progress and actions.
  - The TypeScript execution path is removed.
- **Deployment:** `render.yaml` (Frankfurt; web plus Background Worker; secrets `sync: false`), `worker/Dockerfile` (non-root, locked, no dev tools).
- **Docs:** ADR-006, ADR-001 D6–D8 accepted, Render deploy runbook, run-operations runbook (SQL verified), README, worker README, data lifecycle.

**M1–M2** (still in place):
- patched dependencies;
- error contract, health/readiness;
- Supabase Auth magic links, owner scoping plus RLS (private schema, roles), CSRF, size and rate limits;
- fail-closed config.

## Known gaps before real users

| Gap | Milestone |
|---|---|
| Deterministic (non-LLM) provider only; no evaluation | M4 / M7 |
| No research provenance | M5 |
| No in-app export/delete; retention decisions open ([data lifecycle](docs/security/data-lifecycle.md)) | M6 |
| No alerting on worker heartbeats or stale runs (visibility only); no Playwright E2E | M8 |
| The UI polls (1.5 s) rather than streaming. Time spent in a timed-out stage isn't added to `active_seconds_used`. | — |
| Custom SMTP, sign-up policy, hosted Auth settings | before pilot |

Dev-only advisories: `eslint-config-next@15`'s glob dependencies (lint-time only).
