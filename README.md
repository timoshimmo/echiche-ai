# Echiche (starter, milestone M2)

**Version:** 0.1.0 · **Stage:** M2 "Auth, tenancy and data security" done; next is M3 (durable runs in the Python worker).

> **Not production-ready, but no longer single-user.** Sign-in (Supabase Auth magic links), per-user ownership, row-level security and CSRF/size/rate limits are in place and tested. Still missing before real users: durable background runs (M3), an evaluated AI provider (M4+), export/delete in the app (M6), and the release gates in [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

## Architecture

- **`/` (Next.js 15, TypeScript):** UI, API, authentication and authorization ([ADR-004](docs/decisions/004-auth-and-tenancy.md)).
- **`worker/` (Python 3.12):** owns run execution from M3 ([ADR-001](docs/decisions/001-language-and-service-boundary.md)). Skeleton today.
- **`supabase/`:** Supabase CLI config and SQL migrations, the single source of schema truth ([ADR-002](docs/decisions/002-migration-tooling.md)).
- **`contracts/`:** versioned JSON Schemas shared by both services (from M3).

Data lives in a private Postgres schema `echiche`. It's reachable only through the app, which connects as `echiche_web` and runs each request as `echiche_end_user` with the caller's identity, so RLS enforces ownership in the database as well as in code. The Supabase publishable key cannot reach it.

Runs still execute **synchronously in the API request** with a deterministic, non-LLM scaffold. The UI says so.

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

The server validates configuration at start-up:
- **Production:** it exits on any problem, including `SUPABASE_SERVICE_ROLE_KEY` being present at all.
- **Development:** it keeps serving, and API calls return `503 CONFIG_INVALID`.

Hosted setup (role passwords, Auth URLs, SMTP, Data API exposure) is a manual checklist: [`docs/runbooks/supabase-setup.md`](docs/runbooks/supabase-setup.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Develop / build (needs no env) / serve (needs valid env) |
| `npm run typecheck` · `npm run lint` · `npm test` | Static checks; unit tests (no database, no network) |
| `npm run test:db:prepare` | Prepares a **disposable** database from `TEST_ADMIN_DATABASE_URL`: adds a test-only Supabase shim if needed, applies migrations via the Supabase CLI, sets test role passwords |
| `npm run test:integration` | Repository and RLS tests as the real runtime role. Needs `DATABASE_URL` (echiche_web) and `TEST_ADMIN_DATABASE_URL`. Truncates data, so disposable databases only. |

CI (`.github/workflows/ci.yml`) has four jobs:

| Job | Runs |
|---|---|
| **web** | typecheck, lint, unit tests, build, client-bundle secret scan, production `npm audit` |
| **integration** | plain Postgres 16 with the test shim |
| **supabase-stack** | the real local Supabase stack: integration and RLS suites, plus a check that the Auth server rejects a token after logout |
| **worker** | ruff, pyright strict, pytest |

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
| `POST /api/projects/:id/runs` | `{ prompt }` → 201 run with events (synchronous until M3) |
| `GET /api/runs/:id` | One run plus events |

Another user's resource returns the **same 404** as a nonexistent one. State-changing requests must come from `APP_ORIGIN`, be `application/json`, and be at most 32 KB.

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session |
| `FORBIDDEN` | 403 | Cross-origin state change |
| `VALIDATION_ERROR` | 400 | Malformed JSON or invalid/unknown fields |
| `NOT_FOUND` | 404 | Missing, malformed, or someone else's ID |
| `PROJECT_ARCHIVED` | 409 | Run on an archived project |
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
worker/                 Python worker (skeleton)
docs/decisions/         ADRs 001–004
docs/runbooks/          Supabase environment setup
docs/security/          data lifecycle: storage, export, deletion, retention
```

## Gates still open before real users

1. Durable runs in the worker: 202 + queue, checkpoints, cancellation, idempotency, budgets **[M3]**
2. Provider adapter with token/time/search/spend caps **[M4]**
3. Claim/source provenance before web research **[M5]**
4. In-app export and delete; retention decisions ([data lifecycle](docs/security/data-lifecycle.md)) **[M6]**
5. Custom SMTP, sign-up policy and other hosted Auth settings ([runbook](docs/runbooks/supabase-setup.md)) **[before pilot]**
6. Playwright E2E, security review, backup/restore test, monitoring **[M8]**

## Claude engineering prompt kit

Start with [`CLAUDE.md`](CLAUDE.md), then [`docs/claude-prompts/`](docs/claude-prompts/README.md) one stage at a time. The spec is [`docs/product/Founding_Blueprint_PRD_Engineering_Handoff.md`](docs/product/Founding_Blueprint_PRD_Engineering_Handoff.md).
