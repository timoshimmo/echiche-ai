# Echiche (starter, milestone M1)

**Version:** 0.1.0 · **Stage:** M1 "Stabilize the foundation" done; next is M2 (auth and tenancy).

> **Not production-ready.** There is no authentication or tenant isolation: anyone who can reach the server can read and write every project. Treat it as a single-user local prototype until the gates under [Security gates](#security-and-reliability-gates-before-real-users) are closed. See [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for what is verified.

## Architecture (ADR-001)

- **`/` (Next.js 15, TypeScript):** UI, API routes, and, from M2, auth, authorization and all user-facing CRUD.
- **`worker/` (Python 3.12):** owns run execution from M3 (state machine, budgets, model/research adapters). Today it is a skeleton.
- **`supabase/migrations/`:** plain SQL, the single source of schema truth, applied by `npm run db:migrate`.
- **`contracts/`:** versioned JSON Schemas shared by both sides (from M3).

The two services communicate **only through PostgreSQL rows and versioned contracts**. See [ADR-001](docs/decisions/001-language-and-service-boundary.md).

In M1, thought runs still execute **synchronously inside the API request** using a deterministic scaffold. **It is not an LLM**: no research, no verification, no memory. The UI says so.

## Requirements

- Node.js 22.x and npm 10+ (`engines` in `package.json`)
- For persistent storage and integration tests: PostgreSQL 15+ (16 is what CI uses)
- For the worker: [uv](https://docs.astral.sh/uv/) (it installs Python 3.12 if needed)

## Local development

### Quick start (in-memory demo storage)

```bash
npm ci
cp .env.example .env.local      # sets ALLOW_IN_MEMORY_DEMO=true, DATABASE_URL empty
npm run dev                     # http://localhost:3000
```

Data lives in the dev server's memory and disappears on restart. In-memory mode is **refused when `NODE_ENV=production`**.

### With PostgreSQL

```bash
# 1. A disposable local database (Docker shown; any Postgres 15+ works)
docker run -d --name echiche-pg -e POSTGRES_USER=echiche -e POSTGRES_PASSWORD=change-me \
  -e POSTGRES_DB=echiche_dev -p 5432:5432 postgres:16

# 2. Point the app at it: in .env.local set
#    DATABASE_URL=postgresql://echiche:change-me@localhost:5432/echiche_dev
#    ALLOW_IN_MEMORY_DEMO=false

# 3. Apply migrations (idempotent; safe to re-run)
DATABASE_URL=postgresql://echiche:change-me@localhost:5432/echiche_dev npm run db:migrate

# 4. Run and check readiness
npm run dev
curl localhost:3000/api/ready   # {"status":"ready","persistence":"postgres"}
```

**Upgrading a 0.1.0 database** where `0001_initial_schema.sql` was applied by hand: record it as applied once, then migrate normally:

```bash
DATABASE_URL=... npm run db:migrate -- --baseline=0001_initial_schema.sql
```

Migration 0002 also repairs results that 0.1.0 stored as double-encoded JSON strings.

Use `npm run db:migrate` **or** the Supabase CLI for a given database, not both. They keep separate history tables.

### Worker (Python)

```bash
cd worker && uv sync --locked && uv run pytest
```

See [`worker/README.md`](worker/README.md).

## Environment variables

| Variable | Where | Required | Behaviour |
|---|---|---|---|
| `DATABASE_URL` | web, worker | Web: in production. Worker: always. | Must be `postgres://` or `postgresql://`. Server-side only; never use a `NEXT_PUBLIC_` prefix. |
| `ALLOW_IN_MEMORY_DEMO` | web | no | `"true"`/`"false"`, default `false`. Only honoured outside production. |
| `WORKER_POLL_INTERVAL_SECONDS`, `WORKER_ID` | worker | no | See `worker/README.md`. |

Configuration is validated when the server starts (`src/instrumentation.ts`):
- **In production,** invalid or missing configuration logs `config_invalid`, naming the variables but not their values, and **the process exits with code 1**.
- **In development,** the server keeps running and API calls return `503 CONFIG_INVALID`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (Next core-web-vitals + TypeScript rules) |
| `npm test` | Unit tests (no database, no network) |
| `npm run test:integration` | Integration tests against **a disposable, migrated** Postgres. They TRUNCATE tables, so never run them against shared data. They fail if `DATABASE_URL` is missing. |
| `npm run db:migrate [-- --status \| --baseline=FILE]` | Apply or inspect SQL migrations |
| `npm run build` / `npm start` | Production build / serve (`start` needs a valid `DATABASE_URL`) |

CI (`.github/workflows/ci.yml`) runs three jobs: **web** (typecheck, lint, unit, build, `npm audit --omit=dev --audit-level=high`), **integration** (Postgres 16 service, migrate twice, integration tests) and **worker** (ruff, ruff format check, pyright strict, pytest).

## Health and readiness

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /api/health` | 200 `{"status":"ok"}` whenever the process serves requests. Touches nothing else. | Liveness probe (restart if failing) |
| `GET /api/ready` | 200 `{"status":"ready","persistence":"postgres"\|"in-memory-demo"}` when config is valid **and** storage answers `select 1` within 3 s. Otherwise 503 with `CONFIG_INVALID` or `STORAGE_UNAVAILABLE`. | Readiness probe / load-balancer check; the UI's storage indicator |

Neither endpoint exposes hostnames, versions or secrets.

## API contracts

All private-data endpoints are **unauthenticated until M2**. Responses are `{ "data": ..., "meta": { "persistence": ... } }` on success and `{ "error": { "code", "message" } }` on failure. Messages are fixed strings and never contain exception or driver text.

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body missing, malformed JSON, or fails the schema |
| `NOT_FOUND` | 404 | Unknown **or malformed** project/run ID (malformed IDs never reach storage) |
| `RUN_FAILED` | 500 | The run could not complete; it is persisted as `status: "failed"` with `errorCode` |
| `CONFIG_INVALID` | 503 | Server configuration is invalid |
| `STORAGE_UNAVAILABLE` | 503 | Database unreachable |
| `INTERNAL_ERROR` | 500 | Anything else (logged with error name/code only) |

- `POST /api/projects`: `{ "title": "2–120 chars", "problemStatement": "10–5000 chars" }` → `201` project
- `GET /api/projects`: up to 100 most recent projects
- `POST /api/projects/:projectId/runs`: `{ "prompt": "10–8000 chars" }` → `201` run with `events`. *Synchronous in M1. From M3 it returns `202` and the worker executes the run.*
- `GET /api/projects/:projectId/runs`: up to 50 most recent runs
- `GET /api/runs/:runId`: one run plus its events

Run shape: `{ id, projectId, prompt, status: "queued"|"running"|"succeeded"|"failed", result: object|null, errorCode, createdAt, completedAt }`. `result` is a typed object (`reasoning-scaffold.v1`), stored as JSONB. Events carry a per-run `sequence` (1, 2, 3, …), which is the only reliable order.

## Repository layout

```text
src/app/api/            route handlers: health, ready, projects, runs
src/app/page.tsx        first-slice UI
src/instrumentation.ts  boot-time configuration check
src/lib/domain/         types, Zod schemas, deterministic scaffold (pure; no I/O)
src/lib/server/         config, error contract, logging, repositories, run service
src/test/               integration-test setup
scripts/migrate.mjs     SQL migration runner
supabase/migrations/    schema (plain SQL)
worker/                 Python worker (skeleton)
contracts/              cross-service JSON Schemas (from M3)
docs/decisions/         ADRs
docs/product/           founding blueprint / PRD
docs/claude-prompts/    staged engineering prompts
prompts/runtime/        draft product prompts (unused until M4)
```

## Security and reliability gates before real users

Still open (milestone in brackets):

1. Authentication; `owner_user_id` on every private row, set from the session [M2]
2. Server-side authorization on every handler, Postgres RLS, and denied cross-user tests [M2]
3. Least-privilege DB roles for web and worker (ADR-001 D5); no superuser or service role in the app [M2]
4. Rate limits and request-size limits on POST endpoints [M2]
5. Durable runs in the worker: 202 + queue, checkpoints, cancellation, idempotency, budgets [M3]
6. Provider adapter with token/time/search/spend caps [M4]
7. Claim/source provenance before any web research [M5]
8. Export/delete, retention policy, backup/restore test, privacy copy [M6–M8]
9. Security test suite, Playwright E2E, deployment smoke test, error monitoring [M8]

## Known limitations (M1)

- No auth (see above). Single-user only.
- Runs execute synchronously in the request; the TypeScript `run-service.ts` is removed when the Python worker takes over (M3).
- The scaffold does not use the project's problem statement unless it is copied into the prompt.
- Dev-only advisories remain in `eslint-config-next@15`'s glob dependencies. They clear when moving to Next 16 (`npm audit` without `--omit=dev` shows them).

## Claude engineering prompt kit

Start with [`CLAUDE.md`](CLAUDE.md), then follow [`docs/claude-prompts/`](docs/claude-prompts/README.md) one stage at a time. The founding spec is [`docs/product/Founding_Blueprint_PRD_Engineering_Handoff.md`](docs/product/Founding_Blueprint_PRD_Engineering_Handoff.md).
