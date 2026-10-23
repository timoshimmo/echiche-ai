# Echiche Production Starter Repository

**Version:** 0.1.0  
**Purpose:** Build the first testable slice of Echiche: create a project, start a bounded thought run, capture stages as events, and render the result.

> **Important:** This is a development starter, not production-ready multi-user software. It has no authentication or tenant isolation yet. Do not expose it publicly with real user data until the security gates in this README are completed.

## What works in this slice

1. Create a project with a title and problem statement.
2. Start a thought run attached to a project.
3. Record the `frame → challenge → synthesize` stages as run events.
4. Return a structured result and display it in the UI.
5. Store data in PostgreSQL when `DATABASE_URL` is set; otherwise use in-memory demo storage.
6. Validate API inputs and run unit tests in CI.

The current reasoning engine is deliberately deterministic. It is a scaffold for the end-to-end workflow, **not an LLM**, and it does not perform web research, verify facts, or maintain long-term memory. That boundary is explicit in the UI.

## Requirements

- Node.js 22+
- npm 10+
- Optional: PostgreSQL 15+ / Supabase Postgres

## Run locally

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

Without `DATABASE_URL`, the app uses in-memory demo storage. Data disappears when the Node process restarts and may not be shared across multiple workers.

## Persistent PostgreSQL setup

1. Create a managed PostgreSQL database (Supabase Postgres is one option).
2. Apply `supabase/migrations/0001_initial_schema.sql` using your database migration workflow or SQL editor.
3. Set `DATABASE_URL` in `.env.local` to a server-side connection string. Prefer a pooled connection string in serverless environments.
4. Restart the dev server and confirm the header says `PostgreSQL connected`.

Never prefix `DATABASE_URL` with `NEXT_PUBLIC_`. Do not commit `.env.local`.

## Commands

```bash
npm run dev       # local development
npm run typecheck # TypeScript checks
npm run lint      # ESLint
npm test          # unit tests
npm run build     # production build
npm start         # serve production build
```

## API contracts

### `POST /api/projects`

Request:

```json
{
  "title": "Launch strategy",
  "problemStatement": "Decide how to validate the first customer segment."
}
```

Returns `201` with `{ "data": { ...project }, "meta": { "persistence": "postgres" } }`.

### `GET /api/projects`

Returns the most recent projects.

### `POST /api/projects/:projectId/runs`

Request:

```json
{ "prompt": "What evidence should we gather before choosing our first customer segment?" }
```

Returns `201` with a run, structured result, and event log.

### `GET /api/projects/:projectId/runs`

Lists a project's runs.

### `GET /api/runs/:runId`

Returns one run and its events.

## Repository layout

```text
src/
  app/
    api/projects/                 # project endpoints
    api/projects/[projectId]/runs # run creation/listing
    api/runs/[runId]               # run retrieval
    page.tsx                       # first-slice UI
  lib/domain/                      # types, validation, deterministic workflow, tests
  lib/server/                      # repository interface and storage adapters
supabase/migrations/               # PostgreSQL schema
.github/workflows/ci.yml           # typecheck, lint, tests, build
```

## Architecture decisions in this starter

- **Repository interface:** API and workflow code depend on `EchicheRepository`, not directly on a storage engine.
- **Deterministic run orchestration:** the first slice makes state transitions visible and testable before a model provider is introduced.
- **Provider-neutral next step:** add a `ReasoningProvider` interface, implement one provider adapter server-side, then run it against a fixed evaluation set before enabling it by default.
- **Postgres JSONB result:** stores the structured output; event records provide an append-only execution trace.
- **No graph database yet:** project/run/event relationships are relational and sufficient for this stage.

## Security and reliability gates before public launch

This starter deliberately does **not** implement authentication, per-user project ownership, row-level security, rate limiting, CSRF/origin policy, background job durability, or external model calls. It must be treated as a single-user local prototype until these are added.

Before deploying for real users:

1. Add authentication and `user_id` ownership to projects and all dependent rows.
2. Enforce authorization in every API handler and add Postgres Row Level Security policies; test cross-user access attempts.
3. Use a restricted database role, not a superuser/service role exposed to the browser. Keep all database credentials server-only.
4. Add request rate limits, request IDs, structured redacted logs, and explicit payload/output limits.
5. Move long-running runs to a durable queue/worker; make run creation idempotent and add cancellation/timeouts.
6. Add model provider adapter with per-run token, time, search, and spend caps; handle provider errors and retries.
7. Add a claim/source schema and provenance before introducing web research.
8. Add export/delete workflows, retention policy, backup/restore test, and privacy copy.
9. Add integration tests against a disposable Postgres database and a security test suite.
10. Run a production deployment smoke test and verify error monitoring.

## Known first-slice limitations

- In-memory mode is ephemeral and only suitable for local demonstration.
- The run executes synchronously in the API request; it is not suitable for long model calls.
- The reasoning scaffold does not use the project's problem statement as memory unless the user copies it into the prompt.
- The initial migration is not RLS-protected because there is no auth layer. Do not deploy it as a multi-user application.
- The result is stored as JSONB in PostgreSQL. The repository maps it to a string for a shared interface; Postgres drivers may return JSONB as an object. See the first database integration test milestone before relying on result parsing in the UI.

## Recommended next build increment

1. Auth + tenant ownership + RLS.
2. A persistent run state machine and durable worker.
3. `ReasoningProvider` interface and first model adapter.
4. Fixed evaluation benchmark and cost guardrails.
5. Decision/memory records with user approval and provenance.

## Claude Engineering Prompt Kit

This repository now includes a staged prompt system for building Echiche alongside Claude. Start with:

1. `CLAUDE.md` — persistent product, architecture, security and engineering instructions.
2. `docs/product/Founding_Blueprint_PRD_Engineering_Handoff.md` — searchable founding specification; the Word source is alongside it.
3. `docs/claude-prompts/00-repository-audit-and-architecture.md` — first task, plan-only. Do not skip the architecture decision, especially the TypeScript/Python boundary.
4. Follow the prompts in `docs/claude-prompts/` one stage at a time.
5. Treat `prompts/runtime/` as draft, versioned application prompt assets; schema validation and evaluations are required before production use.

The repository remains a starter scaffold. The presence of a prompt pack, tests, or code files does not mean authentication, tenant isolation, durable orchestration, live AI providers, research verification, memory controls or release gates have already been completed. Consult `IMPLEMENTATION_STATUS.md` and rerun checks before relying on any behavior.
