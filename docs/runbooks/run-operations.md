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
