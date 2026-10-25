# Implementation and verification status

_Last updated: 2026-10-25 (M2, "Auth, tenancy and data security")_

"Verified" means the check was actually run, with the stated result, in the environment noted. Code presence alone is not verification.

## Verified locally (Linux, Node 22.22.0, npm 10.9.4, PostgreSQL 16.15, Supabase CLI 2.120.0, Python 3.12.3)

All of the following were run from a **clean clone** against a **freshly created database**:

| Check | Result |
|---|---|
| `npm ci` | ✅ |
| `npm run typecheck` · `npm run lint` | ✅ 0 errors · 0 problems |
| `npm test` (unit, incl. 17 route-level auth/tenancy/hardening tests) | ✅ 39 tests |
| `npm run build` with no runtime env; client-bundle scan for config/secret names | ✅ · ✅ none found |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| `npm run test:db:prepare` from empty (migrations 0001–0003 via Supabase CLI), then re-run | ✅ · ✅ no-op |
| `npm run test:integration`: 9 repository + 20 RLS tests as `echiche_web` | ✅ 29 tests |
| Same suite with a **Supabase-like admin role** (non-superuser, CREATEROLE, BYPASSRLS) | ✅ 29 tests |
| Migration 0003 refuses a database with pre-auth projects and rolls back cleanly | ✅ |
| Worker: `uv sync --locked`, ruff, ruff format, pyright strict, pytest | ✅ |

**Mutation checks** (each protection removed on purpose to prove its tests catch it):

| Removed | Result |
|---|---|
| App-level owner filter in the in-memory store | 2 route tests fail |
| CSRF origin check | 1 test fails |
| RLS on `echiche.projects` | 5 RLS tests fail; repository tests still pass because the app filter holds |
| App-level owner filter in the Postgres store | repository tests still pass because RLS holds |

So **each layer independently blocks cross-user access.**

**Production-server smoke test** (`next start`, `NODE_ENV=production`, real Postgres, a local HTTPS stand-in for Supabase Auth's `GET /user`, real `@supabase/ssr` session cookies), 19 checks all as expected:
- An unauthenticated page redirects to `/login`; unauthenticated or forged-token API calls return 401.
- Another user gets 404 on read and patch, and an empty list.
- Cross-origin POST returns 403; text/plain POST returns 415.
- `/auth/callback` doesn't redirect to external URLs.
- After sign-out the session returns 401 while other users are unaffected.
- The server refused to start with an http Supabase URL or a non-https `APP_ORIGIN` in production.

## Not yet verified (requires Docker or a hosted project; neither is available in the build environment)

- **The real Supabase stack:** CI job `supabase-stack` (`supabase start`, the same 29 tests, and `scripts/ci/verify-auth-revocation.mjs`, which checks that the real Auth server rejects a token after logout). Confirm the first CI run is green.
- **GitHub Actions** itself has not run.
- **The magic-link email round trip** (sign in, mail catcher, callback, `/`): manual check with `npm run db:start` + `npm run dev`.
- **Hosted staging:** the pooler accepting the custom `echiche_web` role, Auth URL settings, SMTP. See the [runbook](docs/runbooks/supabase-setup.md).

## Implemented

**M2**
- Supabase Auth magic-link sign-in, callback and sign-out, all server-side. httpOnly SameSite=Lax cookies. Middleware page protection.
- Every API route requires a session verified with the Auth server (fails closed with 503 if Auth is down).
- Owner-scoped storage (`Store.forOwner`) with the same 404 for missing and foreign IDs.
- Migration 0003:
  - private `echiche` schema;
  - `owner_user_id` with composite FKs;
  - `echiche_end_user`/`echiche_web`/`echiche_worker` roles with column-scoped grants and no DELETE;
  - FORCE RLS;
  - Supabase API roles revoked;
  - account deletion cascades.
- Project read/update/archive (`GET`/`PATCH /api/projects/:id`), `GET /api/me`.
- CSRF origin check, JSON content-type requirement, 32 KB streamed body cap, strict schemas (no owner smuggling), exact per-user hourly limits on project and run creation.
- Fail-closed configuration (rejects service-role/secret keys, enforces https in production). The in-memory runtime mode is removed.
- Supabase CLI for migrations (ADR-002, accepted). Test DB preparation with a plain-Postgres shim. CI jobs for plain Postgres and the real Supabase stack.
- Docs: ADR-004, Supabase setup runbook, data-lifecycle doc.

**M1** (still in place): patched dependencies, error contract, run failure path, typed JSONB results, event sequence, health/readiness, Python worker skeleton.

## Known gaps before real users

| Gap | Milestone |
|---|---|
| Synchronous runs; no durable worker, cancellation, budgets | M3 |
| No AI provider or evaluation | M4/M7 |
| No research provenance | M5 |
| No in-app export/delete; retention decisions open ([data lifecycle](docs/security/data-lifecycle.md)) | M6 |
| Custom SMTP, sign-up policy, hosted Auth settings | before pilot |
| No pagination beyond the fixed list limits (100 projects, 50 runs) | later |
| No IP-level rate limiting in the app (use the hosting edge); no Playwright E2E | M8 |
| One Auth-server round trip per API request (latency and availability dependency; ADR-004 revisit trigger) | — |

Dev-only advisories: `eslint-config-next@15`'s glob dependencies (lint-time only; cleared by the Next 16 config).
