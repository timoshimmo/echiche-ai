# Implementation and verification status

_Last updated: 2026-10-26 (M4, "Model provider and prompt registry")_

"Verified" means the check was actually run, with the stated result, in the environment noted. Code presence alone is not verification.

## Verified locally (Linux, Node 22.22.0, PostgreSQL 16.15, Supabase CLI 2.120.0, Python 3.12.3, uv 0.11)

From a **clean clone** against a **fresh database**:

| Check | Result |
|---|---|
| `npm ci` · typecheck · lint | ✅ · 0 errors · 0 problems |
| `npm test` (web unit: routes, config incl. refusing `OPENAI_API_KEY`, contracts for both result versions) | ✅ 66 tests |
| `npm run build` (no env); client-bundle scan; `npm audit --omit=dev` | ✅ · none found · 0 vulnerabilities |
| `npm run test:db:prepare` from empty (0001–0005 via Supabase CLI), then re-run | ✅ · ✅ no-op |
| `npm run test:integration`: repository + RLS as `echiche_web`, plus **two cross-language E2Es** (demo worker CLI; model pipeline with a scripted model writing a `decision-brief.v1` and `model_calls` that TS reads through RLS) | ✅ 34 tests |
| Worker: `uv sync --locked`, ruff, ruff format, pyright strict (incl. tests), `contracts --check` | ✅ |
| Worker unit tests (incl. prompt registry, model pipeline, OpenAI adapter against a local mock HTTP server) | ✅ 82 tests |
| Worker integration (as `echiche_worker`) | ✅ 35 tests |
| Same web and worker integration suites on a **fresh cluster with a Supabase-like admin** (non-superuser, CREATEROLE, BYPASSRLS) | ✅ 34 + 35 |
| Upgrading an M3 database with 25 runs: only 0005 applied; M3 `stage-output.v1` checkpoints still load (integration test) | ✅ |

**M4 checks (no live API call was made; there is no key in this environment):**
- **Prompt registry:** loads 3 active and 4 draft prompts. It rejects placeholders, unknown keys, unknown contracts, a changelog that doesn't match the version, and duplicate ids. Draft prompts cannot run.
- **Injection fencing:** user text never reaches the instructions; fence markers in the data are escaped.
- **Model pipeline:**
  - one repair attempt, then `INVALID_PROVIDER_OUTPUT`;
  - an invented citation triggers a repair;
  - refusal and truncation are permanent, and recorded with their cost;
  - the budget preflight pauses with `BUDGET_COST` before anything is sent, and resume continues without re-running stages;
  - a 429 `Retry-After` delays the requeue;
  - switching modes mid-run fails safely with `REASONING_MODE_MISMATCH`;
  - a corrupt model checkpoint is rejected.
- **OpenAI adapter, against the local mock server:**
  - request shape: `store=false`, a strict schema, instructions separate from the data, reasoning effort sent only when set;
  - errors: 429, 5xx, 401/403 and 400 mapped, provider messages never propagated, exactly one HTTP request (SDK retries off);
  - timeout, connection failure, refusal, `incomplete`, and invalid JSON.
- **Spend:** costs match the verified price table (incl. EU +10%); an unknown model fails start-up with exit code 2; every call, including failed ones, counts toward `cost_usd_used`; the worker cannot decrease usage counters; `model_calls` is owner-scoped and append-only.
- **Mutation checks:** removing spend recording on failures fails the integration suite; removing fence escaping fails two unit tests.
- **Worker image:** the image layout was replayed outside Docker (repo-root context, `ECHICHE_PROMPTS_DIR`). `--check-config` with `REASONING_PROVIDER=openai` and a placeholder key loads the registry (exit 0), and fails closed without the prompts directory (exit 2).
- **UI:** the decision-brief view was rendered and inspected at desktop and 390 px widths (no horizontal scroll).

**Bug found and fixed by these tests:** two workers could claim the same queued run. A claimed run stays `queued` until its first stage starts, and `FOR UPDATE` rechecks the predicate against the committed row. The claim query now excludes any run with a live lease. Removing that guard makes the concurrency tests fail (mutation check).

**Production smoke test** (`next start` in production mode, a continuously running worker process, local HTTPS stand-in for Supabase Auth, real session cookies):
- 202 with `Location`; Idempotency-Key replay returns 200.
- The worker ran 3 stages and paused at the 3-step budget. Another user's resume returned 404.
- The owner's resume raised the caps and continued from the checkpoint to "awaiting review". Accept then gave `completed`, and cancelling the finished run returned 409.
- Events were sequenced 1–12.
- On SIGTERM the worker exited cleanly and removed its heartbeat.

**Worker image:** the Dockerfile's build steps were replayed outside Docker (`uv sync --locked --no-dev`, then the entry point). The production environment has no dev tools, and config exit codes are 0/2. The Docker build itself runs in CI.

## Not yet verified (no Docker, hosted accounts or API keys in the build environment)

- **A live OpenAI call.** The opt-in smoke test (`ECHICHE_LIVE_OPENAI=1 … pytest -m live`) is for the decision owner to run with their own key. Model quality is unevaluated until M7.
- **Not verified in OpenAI's docs:** the context window and supported reasoning-effort values of `gpt-6.1-sol`. The official model page was unreachable.

- **GitHub Actions jobs:** `supabase-stack` (real local Supabase), the worker Docker build/run, and the overall first CI run.
- **Render deployment:** the Blueprint, the health check, and the Supabase pooler accepting the `echiche_web.<ref>` / `echiche_worker.<ref>` custom roles. See [render-deploy.md](docs/runbooks/render-deploy.md).
- **The magic-link email round trip** (manual, local stack).

## Implemented

**M4** (ADR-007 accepted 2026-10-26, D9–D12 approved; paid calls stay off until a key is set)
- **Prompt registry** (`prompts/runtime/`, TOML frontmatter, fail-closed loading). The 3 active prompts were rewritten to v2.0.0; the other 4 are drafts.
- **Contracts:** `decision-frame.v1`, `critique.v1`, `decision-brief.v1` (every blueprint §2.6 section), `stage-output.v2`; shared fixtures; Zod mirror with string bounds.
- **`ModelClient` port, OpenAI adapter, model pipeline:** one repair attempt, citation guard, worst-case spend preflight, and call records. The verified price table is dated, with the source URL.
- **Migration 0005:** `echiche.model_calls` (RLS, no content) and monotonic usage counters for the worker.
- **Web:**
  - tagged result union (`schemaVersion`) and a `generation` summary;
  - "Live model (OpenAI · model)" vs "Demo mode" labels, and the brief view;
  - `OPENAI_API_KEY` refused in the web environment; bundle scan extended.
- **Deployment and tests:**
  - worker image built from the repo root (whitelisting `.dockerignore`, `ECHICHE_PROMPTS_DIR`); `render.yaml` provider variables, demo by default; CI image check loads the registry;
  - opt-in live test marker.
- **Docs:** ADR-007, runbooks (enabling live reasoning, spend queries, new error codes), data lifecycle (provider data use), worker and prompt READMEs.

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
| Model output not evaluated (no eval set) | M7 |
| Privacy notice must mention OpenAI (data sent, retention) | before real users |
| `proposed_memory_updates` are displayed only, never saved | M6 |
| A clarifying question from framing is shown as a limitation in the brief; there is no answer-and-continue round-trip yet | later |
| No research provenance | M5 |
| No in-app export/delete; retention decisions open ([data lifecycle](docs/security/data-lifecycle.md)) | M6 |
| No alerting on worker heartbeats or stale runs (visibility only); no Playwright E2E | M8 |
| The UI polls (1.5 s) rather than streaming. Time spent in a timed-out stage isn't added to `active_seconds_used`. | — |
| Custom SMTP, sign-up policy, hosted Auth settings | before pilot |

Dev-only advisories: `eslint-config-next@15`'s glob dependencies (lint-time only).
