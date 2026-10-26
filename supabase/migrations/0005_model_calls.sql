-- M4: model-provider telemetry (ADR-007).
--   * echiche.model_calls: one row per provider call (tokens, cost, latency, prompt
--     id/version/hash, outcome). It never stores prompts, inputs or model output.
--   * usage counters on thought_runs can only grow when the worker writes them, so a
--     bug cannot erase spend that the cost budget depends on.

-- ---------------------------------------------------------------------------
-- 1. Call telemetry.
-- ---------------------------------------------------------------------------
create table echiche.model_calls (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  run_id uuid not null,
  stage text not null check (stage in ('planning', 'researching', 'critiquing', 'verifying', 'synthesizing')),
  attempt integer not null check (attempt >= 1),
  provider text not null check (provider ~ '^[a-z0-9_-]{1,32}$'),
  model text not null check (model ~ '^[A-Za-z0-9._:-]{1,100}$'),
  prompt_id text not null check (prompt_id ~ '^[a-z][a-z0-9-]{1,60}$'),
  prompt_version text not null check (prompt_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  prompt_sha256 text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  output_schema text not null check (output_schema ~ '^[a-z0-9-]+\.v[0-9]+$'),
  repair boolean not null,
  outcome text not null check (outcome in ('ok', 'invalid_output', 'refused', 'truncated', 'error')),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  input_tokens integer not null check (input_tokens >= 0),
  cached_input_tokens integer not null check (cached_input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  reasoning_tokens integer not null check (reasoning_tokens >= 0),
  cost_usd numeric(12, 6) not null check (cost_usd >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  -- clock_timestamp(), not now(): calls recorded in one transaction keep their real order.
  created_at timestamptz not null default clock_timestamp(),
  foreign key (run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id) on delete cascade
);
create index model_calls_run_idx on echiche.model_calls (run_id, created_at);

alter table echiche.model_calls enable row level security;
alter table echiche.model_calls force row level security;
grant select on echiche.model_calls to echiche_end_user, echiche_worker;
grant insert on echiche.model_calls to echiche_worker;
create policy model_calls_owner_select on echiche.model_calls for select to echiche_end_user
  using (owner_user_id = echiche.current_user_id());
create policy model_calls_worker_select on echiche.model_calls for select to echiche_worker using (true);
create policy model_calls_worker_insert on echiche.model_calls for insert to echiche_worker with check (true);

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on echiche.model_calls from %I', r);
    end if;
  end loop;
end $$;
revoke all on echiche.model_calls from public;

-- ---------------------------------------------------------------------------
-- 2. Usage counters never decrease when written by the worker.
-- ---------------------------------------------------------------------------
create function echiche.enforce_usage_monotonic() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'echiche_worker' and (
       new.steps_used < old.steps_used
       or new.active_seconds_used < old.active_seconds_used
       or new.research_calls_used < old.research_calls_used
       or new.cost_usd_used < old.cost_usd_used) then
    raise exception 'usage counters of run % cannot decrease', old.id using errcode = 'P0001', hint = 'RUN_STATE_CONFLICT';
  end if;
  return new;
end $$;

create trigger thought_runs_usage_monotonic
  before update on echiche.thought_runs
  for each row execute function echiche.enforce_usage_monotonic();
