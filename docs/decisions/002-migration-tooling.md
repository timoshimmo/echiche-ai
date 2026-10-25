# ADR-002: Schema migration tooling

- Status: **Accepted** (2026-10-25). The M1 proposal (in-repo runner) is superseded.
- Date: 2026-10-23 (proposed), 2026-10-25 (accepted, revised)
- Decision owner: Tokmang
- Related: Blueprint §5.4 ("All schema changes through reviewed migrations"), ADR-001, ADR-004

## Context
M1 proposed a small in-repo runner (`scripts/migrate.mjs`). M2 adopts Supabase Auth (ADR-004), whose database objects (`auth.users`) our schema references. Local development and CI should therefore run the real Supabase stack, which the Supabase CLI provides (`supabase start`). Keeping a second migration tracker alongside it would split history.

## Decision
Use the **Supabase CLI** (pinned as a dev dependency, `supabase@2.120.0`) for all migrations:
- Plain SQL files in `supabase/migrations/` remain the single source of schema truth. Existing `0001_`/`0002_` names are accepted as versions `0001`/`0002` (verified 2026-10-25 with `supabase migration up`).
- Local: `npm run db:start` (applies migrations), `npm run db:reset`, `npm run db:new-migration -- <name>`.
- Hosted projects: `supabase db push` from a reviewed commit (the CI deploy step is a separate, later approval).
- Tests: `npm run test:db:prepare` applies migrations with `supabase migration up --db-url` against any disposable Postgres. Plain Postgres gets a test-only shim (`src/test/sql/plain-postgres-shim.sql`), so security tests also run without Docker.
- `scripts/migrate.mjs` is deleted. Migration 0003 drops its `public.echiche_schema_migrations` table where present.

## Consequences
- History lives in `supabase_migrations.schema_migrations`.
- Databases migrated in M1 with the old runner: run `supabase migration repair --status applied 0001 0002 --db-url ...` once (see runbook).
- An applied migration is never edited; fixes are new files.
- Local development now needs Docker (for `supabase start`).

## Revisit trigger
The project leaves Supabase, or migrations need steps the CLI cannot express.
