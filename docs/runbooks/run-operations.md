# Runbook: run operations (stuck runs, worker health)

Run these in the Supabase SQL editor (as `postgres`). Run IDs only, never user content, are needed to act on a run.

## Is the worker alive?
```sql
select worker_id, version, last_seen_at, now() - last_seen_at as silent_for, current_run_id
  from echiche.worker_heartbeats order by last_seen_at desc;
```
Each live instance refreshes this about every 20 s (lease/3).
- **Silent for over 2 minutes:** check the Render worker logs for `database_unavailable` or a crash loop.
- **No rows:** no worker is running. Check the Render service.

## Which runs need attention?
```sql
select * from echiche.ops_run_health where problem is not null order by updated_at;
```

| Problem | Meaning | Usual action |
|---|---|---|
| `lease_expired` | The worker holding it died or stalled | None: the next worker poll reclaims it (attempt + 1). If it keeps recurring, read the logs for that `run_id`. |
| `queued_too_long` | Due for over 5 minutes but unclaimed | The worker is down or overloaded. Check heartbeats and scale. |

## Common interventions (operator-only; the transition trigger allows these for postgres)
```sql
-- Retry a failed run from its last checkpoint (keeps completed stages):
update echiche.thought_runs
   set status = 'queued', error_code = null, attempt = 0, available_at = now(),
       claimed_by = null, lease_expires_at = null, completed_at = null
 where id = '<run-id>' and status = 'failed';

-- Force-cancel a run that cannot progress:
update echiche.thought_runs set status = 'cancelled', claimed_by = null, lease_expires_at = null
 where id = '<run-id>';
```
Prefer the user-facing actions (cancel / resume) where possible; they are audited by events.

## Error codes
See `RUN_ERROR_MESSAGES` in `src/lib/domain/types.ts` (user-facing text) and the failure policy in ADR-006.
- **Repeated `PROVIDER_TIMEOUT` / `PROVIDER_UNAVAILABLE` / `PROVIDER_RATE_LIMITED`:** a provider outage or a rate limit. Runs requeue with backoff and fail after `max_attempts`.
- **`PROVIDER_AUTH`:** the worker's `OPENAI_API_KEY` is wrong, revoked or out of quota. Fix the key, then start the affected runs again.
- **`INVALID_PROVIDER_OUTPUT`:** the model failed its contract twice (once after repair). Repeated failures for one prompt version suggest a prompt or contract regression.
- **`RESEARCH_UNAVAILABLE` / `RESEARCH_RATE_LIMITED`:** Brave outage or rate limit. Runs requeue; on their last attempt they continue without that evidence and say so in the brief.
- **`RESEARCH_AUTH`:** the worker's `BRAVE_SEARCH_API_KEY` is wrong or revoked.
- **`BUDGET_RESEARCH`:** the run used its search budget before researching; the user can approve more.
- **`BUDGET_COST`:** the next call's worst case would exceed the run's cap. The user can approve more budget; raise `RUN_BUDGET_MAX_COST_USD` on the web service if this is common.
- **`INTERNAL_ERROR`:** a bug. Search the worker logs for `run_internal_error` with the `run_id`.

## Model spend and failures (M4)
```sql
-- Spend and outcomes per day, model and prompt version
select date_trunc('day', created_at) as day, model, prompt_id, prompt_version, outcome,
       count(*) as calls, sum(cost_usd) as usd, sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens
  from echiche.model_calls
 group by 1, 2, 3, 4, 5
 order by 1 desc, usd desc;

-- Runs whose recorded spend is close to their cap
select id, status, error_code, cost_usd_used, budget_max_cost_usd
  from echiche.thought_runs
 where budget_max_cost_usd > 0 and cost_usd_used >= 0.8 * budget_max_cost_usd
 order by updated_at desc limit 50;
```

## Research health (M5)
```sql
-- Search and fetch outcomes per day (no query text or content is stored)
select date_trunc('day', created_at) as day, kind, provider, outcome, count(*) as n, sum(cost_usd) as usd
  from echiche.research_calls
 group by 1, 2, 3, 4
 order by 1 desc, n desc;

-- Domains most often blocked or failing (robots.txt, opt-outs, timeouts)
select domain, outcome, count(*) as n
  from echiche.research_calls
 where kind in ('fetch', 'robots') and outcome <> 'ok'
 group by 1, 2 order by n desc limit 50;

-- Verification quality: claim statuses per day
select date_trunc('day', created_at) as day, status, count(*) as n
  from echiche.claims group by 1, 2 order by 1 desc;
```

## Memory and decisions (M6)
```sql
-- Proposal review rates (are proposals useful, or mostly rejected?)
select date_trunc('week', created_at) as week, status, sensitivity, count(*) as n
  from echiche.memories where origin = 'model_proposal'
 group by 1, 2, 3 order by 1 desc;

-- Correction rate: memories corrected at least once (a trust and quality signal)
select count(*) filter (where version > 1) as corrected_versions, count(*) as all_rows from echiche.memories;
```
Users delete their own data in the app (hard delete). Operators must not edit memory or decision rows by hand: the triggers allow it for `postgres`, but versions and provenance would then no longer match what the user saw.

## Routing and escalation (M7, ADR-010)
```sql
-- Tier mix, spend and escalations over the last 7 days.
select route_tier, requested_depth, count(*) as runs,
       round(avg(cost_usd_used), 4) as avg_cost_usd,
       count(*) filter (where route_escalation like 'synthesis escalated%') as escalated,
       count(*) filter (where route_escalation like 'escalation triggered%') as justified_not_escalated
  from echiche.thought_runs
 where created_at > now() - interval '7 days'
 group by 1, 2 order by 1, 2;

-- Why a run got its tier (the reasons quote words from the user's prompt: treat as user content).
select route_tier, route_policy_version, route_reasons, route_escalation from echiche.thought_runs where id = '<run id>';
```
A changed `config/routing-policy.json` reaches both services on deploy: the web app classifies new runs with it, and the worker shapes them with it. Deploy web and worker together, so a tier never means different things to the two services.

## Abuse limits and spend ceilings (M8)
The web app reserves each run's spend cap (and each resume's increment) in `echiche.usage_ledger` and refuses new work over `USER_DAILY_SPEND_LIMIT_USD` or `GLOBAL_DAILY_SPEND_LIMIT_USD` (rolling 24 hours) with `429 SPEND_LIMIT_REACHED`. Hourly limits on projects, runs, exports and journal changes count the same ledger, which deleting a project does not erase.
```sql
-- Reserved spend in the last 24 hours: total, and the heaviest users (pseudonymous IDs).
select round(sum(reserved_cost_usd), 2) as reserved_usd from echiche.usage_ledger where created_at > now() - interval '24 hours';
select owner_user_id, round(sum(reserved_cost_usd), 2) as reserved_usd, count(*) filter (where kind = 'run') as runs
  from echiche.usage_ledger where created_at > now() - interval '24 hours'
 group by 1 order by 2 desc limit 10;

-- Reserved vs actually spent (runs still present; deleted projects' runs no longer appear here).
select round(sum(budget_max_cost_usd), 2) as reserved_still_present, round(sum(cost_usd_used), 2) as spent
  from echiche.thought_runs where created_at > now() - interval '24 hours';

-- Housekeeping (operator, monthly): the ledger only needs the last day; keep 30 days for abuse review.
delete from echiche.usage_ledger where created_at < now() - interval '30 days';
```

## Audit trail (M8)
Structured web logs carry `user_id` (a pseudonymous UUID, never an email) on these events:
- `run_queued` and `run_cancel` / `run_accept` / `run_resume`;
- `journal_change` (memory and decision changes, project deletion) and `project_exported`;
- `resource_not_found`: a signed-in user asked for an ID they don't own or that doesn't exist. A burst from one `user_id` across many IDs is probing;
- `origin_rejected`, `rate_limited` and `spend_limited`.

Filter the Render log stream on these event names; no request bodies or content are logged.

## Backup and restore drill (M8)
Run it before the pilot and then quarterly. **Never restore over the live project.**
1. In Supabase, restore the latest daily backup (or a PITR point) into a **new, temporary** project.
2. Check the custom roles came across: `select rolname from pg_roles where rolname like 'echiche%';` should list `echiche_end_user`, `echiche_web` and `echiche_worker`. (Whether Supabase's restore-to-new-project carries custom roles is **unverified here**: a plain `pg_dump` does not include roles.) Then:
   - **If they are missing**, the restored grants and policies refer to roles that don't exist and will have been dropped by the restore. Stop, and recreate the temporary project from the migrations plus a data-only restore instead.
   - **If they are present**, set new login passwords for the temporary project as `postgres`: `alter role echiche_web with login password '<new>'; alter role echiche_worker with login password '<new>';`.
3. Read-only checks (expected results come from the live project):
```sql
select count(*) filter (where relrowsecurity and relforcerowsecurity) as forced, count(*) as tables
  from pg_class where relnamespace = 'echiche'::regnamespace and relkind = 'r';                        -- all forced
select count(*) from pg_policies where schemaname = 'echiche';                                         -- same as live
select string_agg(version, ' ' order by version) from supabase_migrations.schema_migrations;          -- same as live
select (select count(*) from echiche.projects), (select count(*) from echiche.thought_runs);            -- plausible
```
4. Point a local web app at the temporary project as `echiche_web` and sign in with a test account. Its own projects are visible, and nothing else is.
5. Delete the temporary project and record the date and the results in the operations log.

Locally, the same drill (`pg_dump -Fc` → `pg_restore` → the integration suites) was run in M8 ([review](../security/review-m8.md)).

