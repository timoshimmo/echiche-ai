# Implementation and verification status

_Last updated: 2026-10-23 (M1, "Stabilize the foundation")_

"Verified" means the check was actually run, with the stated result, in the environment noted. Code presence alone is not verification.

## Verified locally (Linux, Node 22.22.0, npm 10.9.4, PostgreSQL 16.15, Python 3.12.3, uv 0.11)

| Check | Result |
|---|---|
| `npm ci` from lockfile | ✅ |
| `npm run typecheck` | ✅ 0 errors |
| `npm run lint` | ✅ 0 problems |
| `npm test` | ✅ 25 tests, 5 files |
| `npm run test:integration` (real Postgres 16) | ✅ 9 tests |
| `npm run build` with no `DATABASE_URL` | ✅ |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| `npm run db:migrate`: fresh DB, re-run no-op, 0.1.0 DB via `--baseline`, edited-migration rejected | ✅ |
| `next start` in production without `DATABASE_URL` | ✅ exits 1 with `config_invalid` |
| Production server smoke test against Postgres: create → run → read, 404/400 paths, DB outage → 503, recovery | ✅ |
| Worker: `uv sync --locked`, `ruff check`, `ruff format --check`, `pyright` (strict), `pytest` | ✅ 16 tests |

**Not yet verified:** the GitHub Actions workflow itself. It has not run on GitHub, so confirm the first CI run is green before relying on it.

## Implemented

- Next.js App Router UI and API routes for projects and thought runs; `/api/health` (liveness) and `/api/ready` (readiness).
- Boot-time configuration validation (`src/lib/server/config.ts`, `src/instrumentation.ts`): production fails closed with no in-memory fallback, and malformed values are rejected without echoing them.
- Stable error contract with fixed messages; malformed IDs return 404 without touching storage; structured JSON logs that exclude content and driver messages.
- Run lifecycle: running → succeeded | failed, guarded server-side (only `running` can transition), with `errorCode` on failure. A run is never left `running` after its request ends.
- Typed JSONB results with `result_schema_version`, validated with Zod on write and read (`DataIntegrityError` on a contract mismatch).
- Run events with a per-run `sequence`, unique per run at the database level.
- SQL migration runner with checksums; migration 0002 (error code, schema version, event sequence, repair of 0.1.0 double-encoded results).
- Python worker skeleton (config validation, logging, strict typing, tests). No job loop.
- CI: web, integration (Postgres service) and worker jobs.

## Fixed in M1 (were broken in the 0.1.0 archive)

- `npm run lint` crashed: `eslint-config-next@15` has no flat-config exports. Bridged with `FlatCompat`.
- One unit-test suite failed to load: Vitest did not resolve the `@/` alias.
- `npm run build` reported success while swallowing the ESLint load error.
- CI could not start: `setup-node` `cache: npm` with no lockfile.
- **Critical advisories** in `next@15.5.4` / `react@19.1.1`, including CVE-2025-55182 (RSC remote code execution). Now `next@15.5.28` and `react@19.1.10`, plus a scoped `postcss@8.5.31` override for Next's bundled copy.
- **Results were stored as double-encoded JSON strings** (`jsonb_typeof = 'string'`). Reproduced against Postgres 16; fixed, and existing rows repaired by migration 0002.
- Failed runs stayed `running` forever. Raw database errors (including user-supplied values) were returned to clients.
- The UI showed "PostgreSQL connected" when `DATABASE_URL` was merely set, and always showed "✓ Succeeded".

## Known gaps before real users

See the README section "Security and reliability gates". The headline items: **no authentication or tenant isolation (M2)**, synchronous execution (M3), no provider/evaluation (M4/M7), no rate or size limits (M2), no export/delete/backup verification (M6–M8).

Known dev-only advisories: `eslint-config-next@15` → `@next/eslint-plugin-next` / `fast-glob` / `micromatch` / `braces`. These affect only lint-time tooling and clear with Next 16's config.
