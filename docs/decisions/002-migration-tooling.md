# ADR-002: Schema migration tooling

- Status: **Proposed**. Implemented in M1 as the recommended default; awaiting decision-owner approval.
- Date: 2026-10-23
- Decision owner: Tokmang
- Related: Blueprint §5.4 ("All schema changes through reviewed migrations"), ADR-001 ("Neither ORM owns schema")

## Context
0.1.0 told engineers to paste `0001_initial_schema.sql` into a SQL editor, which leaves no history and no repeatability. Under ADR-001 both TypeScript and Python read the same schema, so neither language's ORM migration tool (Drizzle/Prisma, Alembic) should own it.

## Options considered
- **A: Small in-repo runner (`scripts/migrate.mjs`)** applying `supabase/migrations/*.sql` in order, one transaction per file, with SHA-256 checksums in `echiche_schema_migrations`. No new dependency (uses `postgres`, already present). Cost: we maintain about 80 lines.
- **B: Supabase CLI.** Mature and provider-integrated. Ties local/CI workflow to the Supabase CLI and a Supabase-shaped project, even if the database host changes.
- **C: A migration library** (e.g. node-pg-migrate, dbmate). Adds a dependency for little gain over A at this size.

## Decision (proposed)
Option A. Plain SQL remains the single source of truth; the runner is replaceable later without rewriting migrations.

## Consequences
- An applied migration may never be edited (the checksum check fails hard); fixes are new files.
- 0.1.0 databases are adopted with `--baseline=0001_initial_schema.sql`.
- Don't mix this runner with the Supabase CLI on one database: they keep separate history tables.
- No down-migrations; rollback is forward-fix, documented per migration when risky.

## Revisit trigger
The Supabase CLI becomes necessary for other reasons (branching, storage/auth config as code), or migrations need features the runner lacks (non-transactional steps such as `create index concurrently`).
