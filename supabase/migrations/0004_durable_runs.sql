-- M3: durable, worker-owned run execution (ADR-006).
--   * blueprint run states, enforced per role by a transition trigger
--   * leases + attempts for crash recovery; available_at for retry backoff
--   * budgets and usage counters; idempotent run creation
--   * per-stage checkpoints (run_stage_outputs), worker heartbeats, ops health view
-- The web app no longer executes runs, so the M2-era end-user UPDATE on results is revoked.

-- ---------------------------------------------------------------------------
-- 1. Status model. Map M2 rows: succeeded → completed; a run left 'running' by the
--    old synchronous path can never finish → failed with RUN_ABANDONED.
-- ---------------------------------------------------------------------------
alter table echiche.thought_runs drop constraint thought_runs_status_check;

update echiche.thought_runs set status = 'completed' where status = 'succeeded';
update echiche.thought_runs
   set status = 'failed', error_code = coalesce(error_code, 'RUN_ABANDONED'), completed_at = coalesce(completed_at, now())
 where status = 'running';

alter table echiche.thought_runs
  add constraint thought_runs_status_check check (status in (
    'queued', 'planning', 'researching', 'critiquing', 'verifying', 'synthesizing',
    'awaiting_user_review', 'completed', 'failed', 'cancelled', 'paused_for_budget')),
  alter column status set default 'queued';

-- ---------------------------------------------------------------------------
-- 2. Execution bookkeeping.
-- ---------------------------------------------------------------------------
alter table echiche.thought_runs
  add column idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  -- budgets (caps) and usage
  add column budget_max_steps integer not null default 18 check (budget_max_steps between 1 and 1000),
  add column budget_max_active_seconds integer not null default 600 check (budget_max_active_seconds between 1 and 86400),
  add column budget_max_research_calls integer not null default 8 check (budget_max_research_calls between 0 and 1000),
  add column budget_max_cost_usd numeric(10, 4) not null default 0.50 check (budget_max_cost_usd between 0 and 1000),
  add column steps_used integer not null default 0 check (steps_used >= 0),
  add column active_seconds_used numeric(12, 3) not null default 0 check (active_seconds_used >= 0),
  add column research_calls_used integer not null default 0 check (research_calls_used >= 0),
  add column cost_usd_used numeric(10, 4) not null default 0 check (cost_usd_used >= 0),
  -- claiming / leasing / retries
  add column attempt integer not null default 0 check (attempt >= 0),
  add column max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  add column available_at timestamptz not null default now(),
  add column claimed_by text check (claimed_by is null or claimed_by ~ '^[A-Za-z0-9._-]{1,64}$'),
  add column lease_expires_at timestamptz,
  add column started_at timestamptz,
  add column cancel_requested_at timestamptz,
  add column updated_at timestamptz not null default now();

create unique index thought_runs_owner_idempotency_key
  on echiche.thought_runs (owner_user_id, idempotency_key) where idempotency_key is not null;
create index thought_runs_claimable_idx on echiche.thought_runs (available_at, created_at) where status = 'queued';
create index thought_runs_active_lease_idx on echiche.thought_runs (lease_expires_at)
  where status in ('planning', 'researching', 'critiquing', 'verifying', 'synthesizing');

alter table echiche.run_events drop constraint run_events_event_type_check;
alter table echiche.run_events add constraint run_events_event_type_check
  check (event_type in ('status', 'stage', 'result', 'error', 'budget'));

-- ---------------------------------------------------------------------------
-- 3. Stage checkpoints. One row per completed stage: the primary key makes a retried
--    stage write a no-op, and the worker commits it in the same transaction as the
--    status change and stage event, so a crash can never leave half a stage.
-- ---------------------------------------------------------------------------
create table echiche.run_stage_outputs (
  run_id uuid not null,
  owner_user_id uuid not null,
  stage text not null check (stage in ('planning', 'researching', 'critiquing', 'verifying', 'synthesizing')),
  output jsonb not null check (jsonb_typeof(output) = 'object'),
  output_schema_version text not null check (output_schema_version ~ '^[a-z0-9-]+\.v[0-9]+$'),
  attempt integer not null check (attempt >= 1),
  duration_ms integer not null check (duration_ms >= 0),
  created_at timestamptz not null default now(),
  primary key (run_id, stage),
  foreign key (run_id, owner_user_id) references echiche.thought_runs (id, owner_user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 4. Worker liveness.
-- ---------------------------------------------------------------------------
create table echiche.worker_heartbeats (
  worker_id text primary key check (worker_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  version text not null check (char_length(version) <= 64),
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  current_run_id uuid
);

-- ---------------------------------------------------------------------------
-- 5. Transition rules, enforced for the application roles. Operators (superuser /
--    postgres) are not restricted, for repairs. Also maintains updated_at and
--    completed_at so no caller can forget them.
-- ---------------------------------------------------------------------------
create or replace function echiche.run_stage_rank(s text) returns integer
language sql immutable set search_path = '' as $$
  select case s when 'queued' then 0 when 'planning' then 1 when 'researching' then 2 when 'critiquing' then 3
                when 'verifying' then 4 when 'synthesizing' then 5 else null end
$$;

create or replace function echiche.enforce_run_transition() returns trigger
language plpgsql set search_path = '' as $$
declare
  terminal constant text[] := array['completed', 'failed', 'cancelled'];
  active constant text[] := array['planning', 'researching', 'critiquing', 'verifying', 'synthesizing'];
  budget_changed boolean := (new.budget_max_steps, new.budget_max_active_seconds, new.budget_max_research_calls, new.budget_max_cost_usd)
                            is distinct from
                            (old.budget_max_steps, old.budget_max_active_seconds, old.budget_max_research_calls, old.budget_max_cost_usd);
  ok boolean := false;
begin
  new.updated_at := now();
  if new.status is distinct from old.status and new.status = any (terminal) then
    new.completed_at := now();
  end if;

  if current_user = 'echiche_end_user' then
    if old.status = any (terminal) then
      raise exception 'run % is finished and cannot change', old.id using errcode = 'P0001', hint = 'RUN_STATE_CONFLICT';
    end if;
    if new.cancel_requested_at is distinct from old.cancel_requested_at then
      -- may be set once, never cleared, only while the run can still be cancelled
      ok := old.cancel_requested_at is null and new.cancel_requested_at is not null
            and old.status = any (active) and new.status = old.status;
    elsif new.status = 'completed' then
      ok := old.status = 'awaiting_user_review';                       -- user accepts the result
    elsif new.status = 'queued' then
      ok := old.status = 'paused_for_budget';                          -- user approves more budget
    elsif new.status = 'cancelled' then
      ok := old.status in ('queued', 'paused_for_budget');             -- nothing is executing
    end if;
    if budget_changed and not (old.status = 'paused_for_budget' and new.status = 'queued') then
      ok := false;                                                     -- caps change only on explicit resume...
    end if;
    if budget_changed and (new.budget_max_steps < old.budget_max_steps
        or new.budget_max_active_seconds < old.budget_max_active_seconds
        or new.budget_max_research_calls < old.budget_max_research_calls
        or new.budget_max_cost_usd < old.budget_max_cost_usd) then
      ok := false;                                                     -- ...and only upwards
    end if;
    if not ok then
      raise exception 'transition % -> % not allowed for this user', old.status, new.status using errcode = 'P0001', hint = 'RUN_STATE_CONFLICT';
    end if;
    if new.status = 'queued' then
      new.error_code := null;                                          -- clear the budget reason on resume
    end if;
    return new;
  end if;

  if current_user = 'echiche_worker' then
    if old.status = any (terminal) or old.status in ('awaiting_user_review', 'paused_for_budget') then
      ok := new.status = old.status and new.claimed_by is null and old.claimed_by is not null;  -- releasing a lease only
      if not ok then
        raise exception 'worker cannot change run % in state %', old.id, old.status using errcode = 'P0001', hint = 'RUN_STATE_CONFLICT';
      end if;
      return new;
    end if;
    if new.status = old.status then
      ok := true;                                                      -- claim / lease renewal / usage update
    elsif new.status = any (active) then
      ok := echiche.run_stage_rank(new.status) > echiche.run_stage_rank(old.status);  -- forward only
    elsif new.status = 'queued' then
      ok := old.status = any (active);                                 -- release for retry
    elsif new.status = 'awaiting_user_review' then
      ok := old.status = 'synthesizing';
    elsif new.status in ('failed', 'cancelled', 'paused_for_budget') then
      ok := true;
    end if;
    if not ok then
      raise exception 'transition % -> % not allowed for the worker', old.status, new.status using errcode = 'P0001', hint = 'RUN_STATE_CONFLICT';
    end if;
    return new;
  end if;

  return new;  -- operators
end $$;

create trigger thought_runs_enforce_transition
  before update on echiche.thought_runs
  for each row execute function echiche.enforce_run_transition();

-- ---------------------------------------------------------------------------
-- 6. Privileges. End users: create queued runs, cancel, accept, resume. Nothing else.
-- ---------------------------------------------------------------------------
revoke update on echiche.thought_runs from echiche_end_user;
grant insert (idempotency_key, budget_max_steps, budget_max_active_seconds, budget_max_research_calls, budget_max_cost_usd)
  on echiche.thought_runs to echiche_end_user;
grant update (status, cancel_requested_at, budget_max_steps, budget_max_active_seconds, budget_max_research_calls, budget_max_cost_usd)
  on echiche.thought_runs to echiche_end_user;

-- Run events are execution facts: only the worker writes them now.
revoke insert on echiche.run_events from echiche_end_user;
drop policy events_owner_insert on echiche.run_events;

drop policy runs_owner_insert on echiche.thought_runs;
create policy runs_owner_insert on echiche.thought_runs for insert to echiche_end_user
  with check (owner_user_id = echiche.current_user_id() and status = 'queued');

-- Replace 0003's worker column grants (which included completed_at, now trigger-maintained).
revoke update on echiche.thought_runs from echiche_worker;
grant update (status, result, result_schema_version, error_code, steps_used, active_seconds_used, research_calls_used,
              cost_usd_used, attempt, available_at, claimed_by, lease_expires_at, started_at)
  on echiche.thought_runs to echiche_worker;

alter table echiche.run_stage_outputs enable row level security;
alter table echiche.run_stage_outputs force row level security;
grant select on echiche.run_stage_outputs to echiche_end_user, echiche_worker;
grant insert on echiche.run_stage_outputs to echiche_worker;
create policy stage_outputs_owner_select on echiche.run_stage_outputs for select to echiche_end_user
  using (owner_user_id = echiche.current_user_id());
create policy stage_outputs_worker_select on echiche.run_stage_outputs for select to echiche_worker using (true);
create policy stage_outputs_worker_insert on echiche.run_stage_outputs for insert to echiche_worker with check (true);

alter table echiche.worker_heartbeats enable row level security;
alter table echiche.worker_heartbeats force row level security;
grant select, insert, update, delete on echiche.worker_heartbeats to echiche_worker;
create policy heartbeats_worker_all on echiche.worker_heartbeats for all to echiche_worker using (true) with check (true);

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on echiche.run_stage_outputs, echiche.worker_heartbeats from %I', r);
    end if;
  end loop;
end $$;
revoke all on echiche.run_stage_outputs, echiche.worker_heartbeats from public;

-- ---------------------------------------------------------------------------
-- 7. Operator visibility (SQL editor as postgres; not granted to app roles).
-- ---------------------------------------------------------------------------
create view echiche.ops_run_health with (security_barrier = true) as
select
  r.id as run_id, r.status, r.attempt, r.max_attempts, r.claimed_by, r.lease_expires_at,
  r.available_at, r.created_at, r.updated_at, r.error_code,
  case
    when r.status in ('planning', 'researching', 'critiquing', 'verifying', 'synthesizing')
         and r.lease_expires_at < now() then 'lease_expired'
    when r.status = 'queued' and r.available_at < now() - interval '5 minutes' then 'queued_too_long'
    else null
  end as problem
from echiche.thought_runs r
where r.status not in ('completed', 'failed', 'cancelled');
revoke all on echiche.ops_run_health from public;
