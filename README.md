# Echiche (starter, milestone M6)

**Version:** 0.6.0 · **Stage:** M6 "Memory and decision journal" implemented (ADR-009 accepted); next is M7 (evaluation and adaptive compute).

> **Not production-ready yet.** Already in place:
> - sign-in, per-user isolation (app checks plus row-level security), and CSRF/size/rate limits (M2);
> - durable background runs in the Python worker, with checkpoints, leases, retries, cancellation and budgets (M3);
> - an OpenAI-backed decision brief behind a versioned prompt registry, with strict structured outputs, spend caps and call telemetry (M4). It is **off by default**: the worker runs in demo mode until you set a key ([enabling live reasoning](docs/runbooks/render-deploy.md#enabling-live-reasoning-openai-adr-007));
> - web research with provenance (M5): Brave finds pages, the worker reads them itself, and claims are tied to exact quotes and checked independently. Every citation links to a stored source and passage. Also **off by default** ([enabling research](docs/runbooks/render-deploy.md#enabling-research-brave-adr-008)).
>
> - user-controlled memory and a decision journal (M6). Runs propose memories, and nothing is kept until you approve it. Corrections create new versions. Accepted briefs become versioned decisions with outcomes. Later runs see what was remembered, labelled and dated. Export (JSON) and hard delete are built in.
>
> Still missing before real users: evaluation of the model output (M7), retention decisions, and the release gates in [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

## Architecture

- **`/` (Next.js 15, TypeScript):** UI, API, authentication and authorization ([ADR-004](docs/decisions/004-auth-and-tenancy.md)).
- **`worker/` (Python 3.12):** owns run execution ([ADR-001](docs/decisions/001-language-and-service-boundary.md), [ADR-006](docs/decisions/006-durable-run-orchestration.md)). It claims queued runs from Postgres and runs the five stages durably. It is the only component that calls a model or the web ([ADR-007](docs/decisions/007-model-provider-and-prompt-registry.md), [ADR-008](docs/decisions/008-research-provenance-and-verification.md)).
- **`prompts/runtime/`:** the versioned prompt registry the worker loads (TOML frontmatter, trusted instructions only).
- **`supabase/`:** Supabase CLI config and SQL migrations, the single source of schema truth ([ADR-002](docs/decisions/002-migration-tooling.md)).
- **`contracts/`:** versioned JSON Schemas shared by both services. Pydantic is the source; the TypeScript mirror is checked against it in CI.
- **Hosting:** Render, Frankfurt: web service plus Background Worker ([ADR-005](docs/decisions/005-hosting.md), `render.yaml`).

Data lives in a private Postgres schema `echiche`. It's reachable only through the app, which connects as `echiche_web` and runs each request as `echiche_end_user` with the caller's identity, so RLS enforces ownership in the database as well as in code. The Supabase publishable key cannot reach it.

How a run flows:
1. `POST` returns **202** with a queued run.
2. The worker claims it, works through planning → research → critique → verification → synthesis, and saves a checkpoint after each stage.
3. The run ends at **awaiting review**. The UI polls for progress, and the user accepts, cancels, or approves more budget.

Two reasoning modes, and the UI labels every result with the mode that produced it (from call telemetry):
- **Demo mode** (`REASONING_PROVIDER=deterministic`, the default): the deterministic, non-LLM scaffold.
- **Live model** (`openai`): framing → research → critique → claim verification → decision brief. The brief carries a recommendation, trade-offs, labelled assumptions, the strongest objection, alternatives, calibrated confidence, what would change the decision, and next actions.
- **Research** (`RESEARCH_PROVIDER=brave`, requires the live model):
  - The model plans a few searches (bounded by the run's search budget). Brave returns candidate URLs; search results themselves are never stored.
  - The worker fetches the pages itself (https only, public addresses only, robots.txt and `noarchive`/`noai` honoured, size and time limits) and keeps short passages.
  - The model extracts claims with exact quotes. Each quote is checked against the passage text, then an independent model pass judges support.
  - The brief may cite only sources behind verified claims, and "high" confidence needs two independent domains.
  - With no usable evidence, the brief says research was insufficient and cites nothing.

## Requirements

- Node.js 22.x, npm 10+
- **Docker** (for the local Supabase stack via the pinned Supabase CLI)
- [uv](https://docs.astral.sh/uv/) for the Python worker

## Local development

```bash
npm ci
npm run db:start                 # local Supabase (Postgres + Auth + mail catcher); applies migrations
npx supabase status              # note API URL, publishable/anon key, Mailpit/Inbucket URL

# One-time: give the app's DB role its local password
TEST_ADMIN_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:db:prepare

cp .env.example .env.local       # then paste the publishable key into SUPABASE_PUBLISHABLE_KEY
npm run dev                      # http://localhost:3000 → redirects to /login

# In a second terminal: the worker that executes runs
cd worker && uv sync --locked
DATABASE_URL=postgresql://echiche_worker:test-only-password@127.0.0.1:54322/postgres uv run echiche-worker
```

Sign in with any email address. The local stack doesn't send real email: open the mail-catcher URL from `supabase status` and click the link.

Useful commands: `npm run db:reset` (recreate and re-migrate), `npm run db:new-migration -- <name>`, `npm run db:stop`.

**Coming from M1** (database migrated with the old runner): see "Upgrading a local database from M1" in [the runbook](docs/runbooks/supabase-setup.md).

## Environment variables (web)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | always | Connect **as `echiche_web`**. Never `postgres`, never a service-role key. |
| `SUPABASE_URL` | always | https (plain http only for a local stack in development) |
| `SUPABASE_PUBLISHABLE_KEY` | always | Publishable/anon key. Secret or service-role keys are rejected. |
| `APP_ORIGIN` | production | Exact https origin; used for CSRF checks and auth redirects |
| `PROJECT_CREATE_LIMIT_PER_HOUR`, `RUN_CREATE_LIMIT_PER_HOUR` | no | Per-user caps, default 30 / 20 |
| `RUN_BUDGET_MAX_STEPS` / `_ACTIVE_SECONDS` / `_RESEARCH_CALLS` / `_COST_USD` | no | Per-run caps, default 18 / 600 / 8 / 0.50. The cost cap is enforced before every model call (worst case). |

`OPENAI_API_KEY` is **refused** in the web environment: only the worker may hold it.

Worker variables are in [`worker/README.md`](worker/README.md).

The server validates configuration at start-up:
- **Production:** it exits on any problem, including `SUPABASE_SERVICE_ROLE_KEY` or `OPENAI_API_KEY` being present at all.
- **Development:** it keeps serving, and API calls return `503 CONFIG_INVALID`.

Hosted setup:
- **Supabase** (role passwords, Auth URLs, SMTP, Data API exposure): [`supabase-setup.md`](docs/runbooks/supabase-setup.md)
- **Render** (Blueprint, migrations-first deploys): [`render-deploy.md`](docs/runbooks/render-deploy.md)
- **Stuck runs and worker health:** [`run-operations.md`](docs/runbooks/run-operations.md)

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Develop / build (needs no env) / serve (needs valid env) |
| `npm run typecheck` · `npm run lint` · `npm test` | Static checks; unit tests (no database, no network) |
| `npm run test:db:prepare` | Prepares a **disposable** database from `TEST_ADMIN_DATABASE_URL`: adds a test-only Supabase shim if needed, applies migrations via the Supabase CLI, sets test role passwords |
| `npm run test:integration` | Repository and RLS tests as the real runtime role, plus the cross-language E2E (web queues → Python worker runs → web reads). Needs `DATABASE_URL` (echiche_web), `WORKER_TEST_DATABASE_URL` (echiche_worker) and `TEST_ADMIN_DATABASE_URL`. Truncates data, so disposable databases only. |
| `cd worker && uv run pytest -m integration` | Worker durability (crash/resume, concurrent claims, leases, cancellation, budgets, timeouts, state machine) and the model pipeline with a scripted model (briefs, telemetry, spend caps, repair, RLS on `model_calls`) |
| `cd worker && ECHICHE_LIVE_OPENAI=1 OPENAI_API_KEY=… uv run pytest -m live -s` | **Real, billed** single OpenAI call (< $0.05). Opt-in only; never in CI. |
| `cd worker && ECHICHE_LIVE_BRAVE=1 BRAVE_SEARCH_API_KEY=… uv run pytest -m live -s -k research` | **Real** single Brave search ($0.005) plus page fetches through the production guards. Opt-in only. |

CI (`.github/workflows/ci.yml`) has four jobs:

| Job | Runs |
|---|---|
| **web** | typecheck, lint, unit tests, build, client-bundle secret scan, production `npm audit` |
| **integration** | plain Postgres 16 with the test shim: web integration, cross-language E2E, worker integration |
| **supabase-stack** | the real local Supabase stack: integration and RLS suites, plus a check that the Auth server rejects a token after logout |
| **worker** | ruff, pyright strict, pytest, contract-schema freshness, Docker image build and start |

## API

Every route except `/api/health` and `/api/ready` requires a signed-in session (cookie). Errors are `{ "error": { "code", "message" } }` with fixed messages; success is `{ "data": ... }`.

| Method + path | Behaviour |
|---|---|
| `GET /api/me` | The caller's `{ id, email }` |
| `GET /api/projects[?includeArchived=true]` | Caller's projects (≤100, newest first) |
| `POST /api/projects` | `{ title, problemStatement }` → 201. Unknown fields are rejected, so the owner can't be smuggled in. |
| `GET /api/projects/:id` | One project |
| `PATCH /api/projects/:id` | Any of `{ title, problemStatement, archived }`; `archived:true` archives (idempotent) |
| `GET /api/projects/:id/runs` | Runs (≤50) |
| `POST /api/projects/:id/runs` | `{ prompt }` → **202** queued run plus `Location`. Optional `Idempotency-Key` header: a same-request replay returns 200; a different body returns 409. |
| `GET /api/runs/:id` | Run (status, completed stages, budget, usage, error code, `result` tagged with its `schemaVersion`, `generation` summary: mode, provider, models, prompt versions, calls, tokens, cost) plus events and `evidence` (sources read, with passages, and claims with their quotes and verdicts). Poll this. |
| `POST /api/runs/:id/cancel` | Queued or paused: cancelled now. Active: stops at the next stage. Idempotent. |
| `POST /api/runs/:id/accept` | awaiting review → completed |
| `POST /api/runs/:id/resume` | Budget-paused → queued, raising the caps (the user's explicit approval) |
| `DELETE /api/projects/:id` | Permanently delete the project and everything in it |
| `GET /api/projects/:id/export` | `echiche-export.v1` JSON attachment (project, runs, sources, claims, memories, decisions) |
| `GET /api/projects/:id/memories[?status=&kind=&q=]` | Memories; default `active`; `proposed` shows what runs suggested |
| `POST /api/projects/:id/memories` | `{ kind, content, confidence? }`: your own memory, active at once |
| `POST /api/memories/:id/approve` · `/reject` | Review a proposal: approve (may edit; sensitive ones need `confirmSensitive: true`) or reject |
| `PATCH /api/memories/:id` | Correct: a new version supersedes the current one |
| `GET /api/memories/:id/history` · `DELETE /api/memories/:id` | All versions · delete every version |
| `GET /api/projects/:id/decisions` | Decision journal: versions (newest first) with outcomes |
| `POST /api/decisions/:id/revise` · `/outcomes` | New decision version (earlier rationale kept) · append an outcome |

Another user's resource returns the **same 404** as a nonexistent one. State-changing requests must come from `APP_ORIGIN`, be `application/json`, and be at most 32 KB.

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Cross-origin state change |
| `VALIDATION_ERROR` | 400 | Malformed JSON or invalid/unknown fields |
| `NOT_FOUND` | 404 | Missing, malformed, or someone else's ID |
| `PROJECT_ARCHIVED` | 409 | Run on an archived project |
| `RUN_STATE_CONFLICT` / `IDEMPOTENCY_CONFLICT` | 409 | Action not allowed in the run's state / key reused for a different request |
| `MEMORY_STATE_CONFLICT` / `DECISION_STATE_CONFLICT` / `SENSITIVE_CONFIRMATION_REQUIRED` | 409 | Memory action not allowed in its state / only the current decision can be revised / a sensitive proposal needs explicit confirmation |
| `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` | 413 / 415 | Body limits |
| `RATE_LIMITED` | 429 | Hourly per-user cap reached (`Retry-After`) |
| `RUN_FAILED` | 500 | Run persisted as `failed` with `errorCode` |
| `CONFIG_INVALID` / `AUTH_UNAVAILABLE` / `STORAGE_UNAVAILABLE` | 503 | Misconfiguration / Auth server down / database down (fail closed) |
| `INTERNAL_ERROR` | 500 | Anything else (logged by name and code only) |

Auth endpoints (form posts and redirects, not JSON): `POST /auth/sign-in` (always answers "check your email", so it can't reveal which accounts exist), `GET /auth/callback`, `POST /auth/sign-out`.

## Health and readiness

| Endpoint | Meaning |
|---|---|
| `GET /api/health` | 200 when the process serves requests (liveness) |
| `GET /api/ready` | 200 when config is valid and the database answers within 3 s, otherwise 503 (readiness) |

## Repository layout

```text
src/app/api/            JSON API routes
src/app/auth/           sign-in, callback, sign-out (server-side Supabase Auth)
src/app/login/          sign-in page
src/middleware.ts       page protection + session refresh
src/lib/domain/         types, Zod schemas, deterministic scaffold (pure)
src/lib/server/         config, auth, HTTP guards, logging, owner-scoped stores, run service
src/test/               integration setup, test DB helpers, plain-Postgres shim
scripts/                test DB preparation; CI auth-revocation check
supabase/               CLI config.toml and migrations
worker/                 Python worker (claim loop, executor, store, contracts, prompt registry, OpenAI adapter,
                        Brave adapter, safe page fetcher, research and verification pipeline) + Dockerfile
prompts/runtime/        versioned runtime prompts (registry format; ADR-007)
contracts/              JSON Schemas + shared fixtures
render.yaml             Render Blueprint (Frankfurt)
docs/decisions/         ADRs 001–009
docs/runbooks/          Supabase setup, Render deploy, run operations
docs/security/          data lifecycle: storage, export, deletion, retention
```

## Gates still open before real users

1. ~~Provider adapter with token/time/spend caps~~ **[M4, done; ADR-007 accepted]**; output-quality evaluation **[M7]**
2. ~~Claim/source provenance before web research~~ **[M5, done]**; Brave's written confirmation on result use and excerpt storage **[before enabling research for real users]**
3. ~~In-app export and delete~~ **[M6, done]**; retention decisions and self-service account deletion ([data lifecycle](docs/security/data-lifecycle.md)) **[before pilot]**
4. Custom SMTP, sign-up policy and other hosted Auth settings ([runbook](docs/runbooks/supabase-setup.md)) **[before pilot]**
5. Playwright E2E, security review, backup/restore test, monitoring and alerting on worker heartbeats **[M8]**

## Claude engineering prompt kit

Start with [`CLAUDE.md`](CLAUDE.md), then [`docs/claude-prompts/`](docs/claude-prompts/README.md) one stage at a time. The spec is [`docs/product/Founding_Blueprint_PRD_Engineering_Handoff.md`](docs/product/Founding_Blueprint_PRD_Engineering_Handoff.md).
